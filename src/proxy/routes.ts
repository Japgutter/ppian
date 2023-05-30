/* Accepts incoming requests at either the /kobold or /openai routes and then
routes them to the appropriate handler to be forwarded to the OpenAI API.
Incoming OpenAI requests are more or less 1:1 with the OpenAI API, but only a
subset of the API is supported. Kobold requests must be transformed into
equivalent OpenAI requests. */

import * as express from "express";
import { AIService } from "../key-management";
import { gatekeeper } from "./auth/gatekeeper";
import { kobold } from "./kobold";
import { openai } from "./openai";
import { anthropic } from "./anthropic";

const router = express.Router();

router.use(gatekeeper);
router.use("/kobold", kobold);
router.use("/openai", openai);
router.use("/anthropic", anthropic);

export function setApiFormat(api: {
  in: express.Request["inboundApi"];
  out: AIService;
}): express.RequestHandler {
  return (req, _res, next) => {
    req.inboundApi = api.in;
    req.outboundApi = api.out;
    next();
  };
}

export { router as proxyRouter };
