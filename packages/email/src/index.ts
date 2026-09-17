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
  createEmailNotificationChannel,
  isContactSuppressed,
  type CreateEmailChannelOptions,
  type EmailNodeData,
  type EmailTemplateLookup,
} from "./channel";
export { processEmailWebhook } from "./webhook";
