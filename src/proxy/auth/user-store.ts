/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import { v4 as uuid } from "uuid";
import { config, getFirebaseApp } from "../../config";
import { logger } from "../../logger";

export interface User {
  /** The user's personal access token. */
  token: string;
  /** The IP addresses the user has connected from. */
  ip: string[];
  ipPromptCount: Map<string, number>; 
  /** The user's privilege level. */
  type: UserType;
  /** The number of prompts the user has made. */
  promptCount: number;
  
  /** Count claude and gpt prompts */
  promptClaudeCount: number;
  promptGptCount: number;
  
  
  /** Prompt Limit for temp user */ 
  promptLimit?: number;
  /** Time Limit for temp user */ 
  endTimeLimit?: number;
  timeLimit?: number;
  /** The number of tokens the user has consumed. Not yet implemented. (Working on it) */
  tokenClaudeCount: number;
  tokenGptCount: number;
  
  
  /** Rate limit of user_token */
  rateLimit?: number;
  
  /** The time at which the user was created. */
  createdAt: number;
  /** The time at which the user last connected. */
  lastUsedAt?: number;
  /** The time at which the user was disabled, if applicable. */
  disabledAt?: number;
  /** The reason for which the user was disabled, if applicable. */
  disabledReason?: string;
 
}

/**
 * Possible privilege levels for a user.
 * - `normal`: Default role. Subject to usual rate limits and quotas.
 * - `special`: Special role. Higher quotas and exempt from auto-ban/lockout.
 * TODO: implement auto-ban/lockout for normal users when they do naughty shit
 */
export type UserType = "normal" | "special" | "temp";

type UserUpdate = Partial<User> & Pick<User, "token">;

const MAX_IPS_PER_USER = config.maxIpsPerUser;

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();

export async function init() {
  logger.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  }
  logger.info("User store initialized.");
}




/** Creates a new user and returns their token. */
export function createUser(rLimit: any) {
  rLimit = parseInt(rLimit)
  const token = uuid();
  users.set(token, {
    token,
    ip: [],
	ipPromptCount: new Map(),
    type: "normal",
    promptCount: 0,
	promptClaudeCount: 0,
	promptGptCount: 0,
	rateLimit: rLimit,
    tokenClaudeCount: 0,
	tokenGptCount: 0,
    createdAt: Date.now(),
  });
  usersToFlush.add(token);
  return token;
}


function generateTempString(): string {
  const userid = uuid().replace(/-/g, '');
  let randomizedUUID = '';
  for (let i = 0; i < userid.length; i++) {
    const char = userid[i];
    const randomCase = Math.random() < 0.5 ? char.toLowerCase() : char.toUpperCase();
    randomizedUUID += randomCase;
  }
  return randomizedUUID;
}
/** Creates a new temp user and returns their token. */
export function createTempUser(pLimit: any, tLimit: any, rLimit: any) {
  rLimit = parseInt(rLimit)
  pLimit = parseInt(pLimit)
  tLimit = parseInt(tLimit)  
  const token = "temp-"+generateTempString();
  users.set(token, {
    token,
    ip: [],
	ipPromptCount: new Map(),
    type: "temp",
    promptCount: 0,
	promptClaudeCount: 0,
	promptGptCount: 0,
	rateLimit: rLimit,
	promptLimit: pLimit,
	timeLimit: tLimit,
	endTimeLimit: -1,
    tokenClaudeCount: 0,
	tokenGptCount: 0,
	
    createdAt: Date.now(),
  });
  usersToFlush.add(token);
  return token;
}



/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user 
  }));
}


export function getPublicUsers() {
  try {
	  const usersArray = Array.from(users);
	  const updatedUsersArray = usersArray.map((user, index) => {
		const updatedUser = {
		  createdAt: user[1].createdAt,
		  lastUsedAt: user[1].lastUsedAt,
		  token: index,
		  type: user[1].type,
		  promptLimit: user[1].promptLimit,
		  timeLimit: user[1].timeLimit,
		  endTimeLimit: user[1].endTimeLimit,
		  promptCount: user[1].promptCount,
		  promptClaudeCount: user[1].promptClaudeCount,
		  promptGptCount: user[1].promptGptCount,
		  tokenClaudeCount: user[1].tokenClaudeCount,
		  tokenGptCount: user[1].tokenGptCount
		};
		// Remove hidden ones (Make them Hidden before to make sure everything is fine ._.)
		return updatedUser;
	  });
	  return updatedUsersArray;
  } catch (error) {
    return "{'error':'An error occurred while retrieving public users'}"
  }
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * user information via JSON. Use other functions for more specific operations.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
	ipPromptCount: new Map(),
	promptClaudeCount: 0,
	promptGptCount: 0,
	promptLimit: -1,
    tokenClaudeCount: 0,
	tokenGptCount: 0,
    createdAt: Date.now(),
  };

  users.set(user.token, {
    ...existing,
    ...user,
  });
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if we're using Firebase.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string, model: string, user_ip: string) {
  const user = users.get(token);
  if (!user) return;
  
  if (user.ipPromptCount.get(user_ip) === undefined) {
	  user.ipPromptCount.set(user_ip, 1);
   } else {
	  const count = user.ipPromptCount.get(user_ip);
	  if (typeof count === 'number') {
		user.ipPromptCount.set(user_ip, count + 1);
		}
   }
  
  user.promptCount++;
  if (model.slice(0, 3) == "gpt") {
	  user.promptGptCount++;
  } else if (model.slice(0, 3) == "cla") {
	  user.promptClaudeCount++;
  }
  
  
  if(user.type == "temp" && (user.disabledAt ?? false) == false) {
	  if ((user.endTimeLimit ?? 0) == -1 && (user.promptLimit ?? 0) == -1) {
		  user.endTimeLimit = Date.now() + ((user.timeLimit ?? 0)*1000);
		  }
	  if ((user.promptLimit ?? 0) != -1 && user.promptCount >=  (user.promptLimit ?? 0)) {
		  // Deletes token 
		  users.delete(user.token)
	  } 
	  if ((user.promptLimit ?? 0) == -1 && Date.now() >= (user.endTimeLimit ?? 0) && (user.timeLimit ?? -1) != -1) {
		  // Deletes token 
		  users.delete(user.token);
	  }
  }
  usersToFlush.add(token);
}






/** Increments the token count for the given user by the given amount. */
export function incrementTokenCount(token: string, amount = 1, service: string) {
  const user = users.get(token);
  if (!user) return;
  
  if (service == "openai") {
	user.tokenGptCount += amount;
  } else if (service == "anthropic") {
	user.tokenClaudeCount += amount;
  }
  
  usersToFlush.add(token);
}




/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(token: string, ip: string) {
  const user = users.get(token);
  if (!user || user.disabledAt) return;
  if (!user.ip.includes(ip)) user.ip.push(ip);

  // If too many IPs are associated with the user, disable the account.
  const ipLimit =
    user.type === "special" || !MAX_IPS_PER_USER ? Infinity : MAX_IPS_PER_USER;
  if (user.ip.length > ipLimit) {
    disableUser(token, "Too many IP addresses associated with this token.");
    return;
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return user;
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  usersToFlush.add(token);
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;

async function initFirebase() {
  logger.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const snapshot = await usersRef.once("value");
  const users: Record<string, User> | null = snapshot.val();
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);
  if (!users) {
    logger.info("No users found in Firebase.");
    return;
  }
  for (const token in users) {
    upsertUser(users[token]);
  }
  usersToFlush.clear();
  const numUsers = Object.keys(users).length;
  logger.info({ users: numUsers }, "Loaded users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref("users");
  const updates: Record<string, User> = {};

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  logger.info(
    { users: Object.keys(updates).length },
    "Flushed users to Firebase"
  );
}