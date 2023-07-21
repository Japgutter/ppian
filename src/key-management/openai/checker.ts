import axios, { AxiosError } from "axios";
import { logger } from "../../logger";
import type { OpenAIKey, OpenAIKeyProvider } from "./provider";

/** Minimum time in between any two key checks. */
const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
/**
 * Minimum time in between checks for a given key. Because we can no longer
 * read quota usage, there is little reason to check a single key more often
 * than this.
 **/
const KEY_CHECK_PERIOD = 30 * 60 * 1000; // 30 minutes

const POST_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_SUBSCRIPTION_URL =
  "https://api.openai.com/dashboard/billing/subscription";

type GetModelsResponse = {
  data: [{ id: string }];
};

type GetSubscriptionResponse = {
  plan: { title: string };
  has_payment_method: boolean;
  soft_limit_usd: number;
  hard_limit_usd: number;
  system_hard_limit_usd: number;
};

type OpenAIError = {
  error: { type: string; code: string; param: unknown; message: string };
};

type UpdateFn = typeof OpenAIKeyProvider.prototype.update;

export class OpenAIKeyChecker {
  private readonly keys: OpenAIKey[];
  private log = logger.child({ module: "key-checker", service: "openai" });
  private timeout?: NodeJS.Timeout;
  private updateKey: UpdateFn;
  private lastCheck = 0;

  constructor(keys: OpenAIKey[], updateKey: UpdateFn) {
    this.keys = keys;
    this.updateKey = updateKey;
  }

  public start() {
    this.log.info("Starting key checker...");
    this.scheduleNextCheck();
  }

  public stop() {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
  }

  /**
   * Schedules the next check. If there are still keys yet to be checked, it
   * will schedule a check immediately for the next unchecked key. Otherwise,
   * it will schedule a check in several minutes for the oldest key.
   **/
  private scheduleNextCheck() {
    const enabledKeys = this.keys.filter((key) => !key.isDisabled);

    if (enabledKeys.length === 0) {
      this.log.warn("All keys are disabled. Key checker stopping.");
      return;
    }

    // Perform startup checks for any keys that haven't been checked yet.
    const uncheckedKeys = enabledKeys.filter((key) => !key.lastChecked);
    if (uncheckedKeys.length > 0) {
      // Check up to 12 keys at once to speed up startup.
      const keysToCheck = uncheckedKeys.slice(0, 12);

      this.log.info(
        {
          key: keysToCheck.map((key) => key.hash),
          remaining: uncheckedKeys.length - keysToCheck.length,
        },
        "Scheduling initial checks for key batch."
      );
      this.timeout = setTimeout(async () => {
        const promises = keysToCheck.map((key) => this.checkKey(key));
        try {
          await Promise.all(promises);
        } catch (error) {
          this.log.error({ error }, "Error checking one or more keys.");
        }
        this.scheduleNextCheck();
      }, 250);
      return;
    }

    // Schedule the next check for the oldest key.
    const oldestKey = enabledKeys.reduce((oldest, key) =>
      key.lastChecked < oldest.lastChecked ? key : oldest
    );

    // Don't check any individual key more than once every 5 minutes.
    // Also, don't check anything more often than once every 3 seconds.
    const nextCheck = Math.max(
      oldestKey.lastChecked + KEY_CHECK_PERIOD,
      this.lastCheck + MIN_CHECK_INTERVAL
    );

    this.log.debug(
      { key: oldestKey.hash, nextCheck: new Date(nextCheck) },
      "Scheduling next check."
    );

    const delay = nextCheck - Date.now();
    this.timeout = setTimeout(() => this.checkKey(oldestKey), delay);
  }

  private async checkKey(key: OpenAIKey) {
    // It's possible this key might have been disabled while we were waiting
    // for the next check.
    if (key.isDisabled) {
      this.log.warn({ key: key.hash }, "Skipping check for disabled key.");
      this.scheduleNextCheck();
      return;
    }

    this.log.debug({ key: key.hash }, "Checking key...");
    let isInitialCheck = !key.lastChecked;
    try {
      // We only need to check for provisioned models on the initial check.
      if (isInitialCheck) {
        const [subscription, provisionedModels, _livenessTest] =
          await Promise.all([
            this.getSubscription(key),
            this.getProvisionedModels(key),
            this.testLiveness(key),
          ]);
        const updates = {
          isGpt4: provisionedModels.gpt4,
          isTrial: !subscription.has_payment_method,
          softLimit: subscription.soft_limit_usd,
          hardLimit: subscription.hard_limit_usd,
          systemHardLimit: subscription.system_hard_limit_usd,
        };
        this.updateKey(key.hash, updates);
      } else {
        // Provisioned models don't change, so we don't need to check them again
        const [subscription, _livenessTest] = await Promise.all([
          this.getSubscription(key),
          this.testLiveness(key),
        ]);
        const updates = {
          softLimit: subscription.soft_limit_usd,
          hardLimit: subscription.hard_limit_usd,
          systemHardLimit: subscription.system_hard_limit_usd,
        };
        this.updateKey(key.hash, updates);
      }
      this.log.info(
        { key: key.hash, hardLimit: key.hardLimit },
        "Key check complete."
      );
    } catch (error) {
      // touch the key so we don't check it again for a while
      this.updateKey(key.hash, {});
      this.handleAxiosError(key, error as AxiosError);
    }

    this.lastCheck = Date.now();
    // Only enqueue the next check if this wasn't a startup check, since those
    // are batched together elsewhere.
    if (!isInitialCheck) {
      this.scheduleNextCheck();
    }
  }

  private async getProvisionedModels(
    key: OpenAIKey
  ): Promise<{ turbo: boolean; gpt4: boolean }> {
    const opts = { headers: { Authorization: `Bearer ${key.key}` } };
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
    const models = data.data;
    const turbo = models.some(({ id }) => id.startsWith("gpt-3.5"));
    const gpt4 = models.some(({ id }) => id.startsWith("gpt-4"));
    return { turbo, gpt4 };
  }

  private async getSubscription(key: OpenAIKey) {
    const { data } = await axios.get<GetSubscriptionResponse>(
      GET_SUBSCRIPTION_URL,
      { headers: { Authorization: `Bearer ${key.key}` } }
    );
    return data;
  }

  private handleAxiosError(key: OpenAIKey, error: AxiosError) {
    if (error.response && OpenAIKeyChecker.errorIsOpenAiError(error)) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true });
      } else if (status === 429 && data.error.type === "insufficient_quota") {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is out of quota. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true });
      } else if (status === 429 && data.error.type === "access_terminated") {
        this.log.warn(
          { key: key.hash, error: data },
          "Key has been terminated due to policy violations. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true });
      } else if (status === 429 && data.error.type === "billing_not_active") {
        this.log.warn(
          { key: key.hash, error: data },
          "Key deactivated due to delinquent billing. Disabling key."
        );
        this.updateKey(key.hash, { isDisabled: true });
      } else if (
        status === 429 &&
        ["requests", "tokens"].includes(data.error.type)
      ) {
        const rateLimitType = data.error.type;
        if (rateLimitType === "requests") {
          // Trial keys have extremely low requests-per-minute limits and we can
          // often hit them just while checking the key, so we need to retry the
          // check later to know if the key has quota remaining.
          this.log.warn(
            { key: key.hash, error: data },
            "Key is currently rate limited, so its liveness cannot be checked. Retrying in fifteen seconds."
          );
          // To trigger a shorter than usual delay before the next check, we will
          // set its `lastChecked` to (NOW - (KEY_CHECK_PERIOD - 15s)).
          // This will cause the usual key check scheduling logic to schedule the
          // next check in 15 seconds. This also prevents the key from holding up
          // startup checks for other keys.
          const fifteenSeconds = 15 * 1000;
          const nextCheck = Date.now() - (KEY_CHECK_PERIOD - fifteenSeconds);
          this.updateKey(key.hash, { lastChecked: nextCheck });
        } else if (rateLimitType === "tokens") {
          // Hitting a token rate limit, even on a trial key, actually implies
          // that the key is valid and can generate completions, so we will
          // treat this as effectively a successful `testLiveness` call.
          this.log.info(
            { key: key.hash },
            "Key is currently `tokens` rate limited; assuming it is operational."
          );
          this.updateKey(key.hash, { lastChecked: Date.now() });
        }
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered API error while checking key."
        );
      }
      return;
    }
    this.log.error(
      { key: key.hash, error },
      "Network error while checking key; trying again later."
    );
  }

  /**
   * Tests whether the key is valid and has quota remaining. The request we send
   * is actually not valid, but keys which are revoked or out of quota will fail
   * with a 401 or 429 error instead of the expected 400 Bad Request error.
   * This lets us avoid test keys without spending any quota.
   */
  private async testLiveness(key: OpenAIKey): Promise<void> {
    const payload = {
      model: "gpt-3.5-turbo",
      max_tokens: -1,
      messages: [{ role: "user", content: "" }],
    };
    const { data } = await axios.post<OpenAIError>(
      POST_CHAT_COMPLETIONS_URL,
      payload,
      {
        headers: { Authorization: `Bearer ${key.key}` },
        validateStatus: (status) => status === 400,
      }
    );
    if (data.error.type === "invalid_request_error") {
      // This is the expected error type for our bad prompt, so key is valid.
      return;
    } else {
      this.log.warn(
        { key: key.hash, error: data },
        "Unexpected 400 error class while checking key; assuming key is valid, but this may indicate a change in the API."
      );
    }
  }

  static errorIsOpenAiError(
    error: AxiosError
  ): error is AxiosError<OpenAIError> {
    const data = error.response?.data as any;
    return data?.error?.type;
  }
}
