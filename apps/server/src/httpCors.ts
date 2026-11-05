import { KITTY_DEV_PROTOCOL_SCHEME, KITTY_PROTOCOL_SCHEME } from "@t3tools/shared/kittyBrand";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${KITTY_PROTOCOL_SCHEME}://app`,
  `${KITTY_DEV_PROTOCOL_SCHEME}://app`,
] as const;
