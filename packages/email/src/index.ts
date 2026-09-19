export type {
  EmailProvider,
  NormalizedEmailEvent,
  SendEmailInput,
  SendEmailResult,
  WebhookRequest,
} from "./provider";
export { ConsoleEmailProvider } from "./ConsoleEmailProvider";
export { ResendProvider } from "./ResendProvider";
export { renderTemplate } from "./render";
export {
  appendUtmParams,
  createEmailNotificationChannel,
  defaultRecipientGate,
  injectPreheader,
  type CreateEmailChannelOptions,
  type EmailNodeData,
  type EmailTemplateLookup,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationResult,
  type RecipientGate,
  type RecipientGateInput,
  type UnsubscribeLink,
  type UnsubscribeLinkPayload,
} from "./channel";
export { processEmailWebhook, type WebhookContactEvent } from "./webhook";
export {
  createWorkspaceSendLimiter,
  sendLimitsFromEnv,
  type SendLimiter,
  type SendSlotRelease,
  type WorkspaceLimiterStat,
  type WorkspaceSendLimiterConfig,
  type WorkspaceSendLimiterStats,
  type WorkspaceSendLimits,
} from "./rateLimit";
