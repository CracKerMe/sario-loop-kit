/**
 * `@loopkit/email-doc` — the email document format, its validator, and its
 * renderer.
 *
 * The package exists so that the editor and the server share one definition of
 * what an email template *is*. It has no React and no DOM dependency, which is
 * what lets the validator and the renderer run as a hard trust boundary on
 * server-side, client-submitted JSON.
 *
 * See `types.ts` for the document model and the reasoning behind a closed
 * block set and enum-only attributes.
 */
export {
  ALIGN_TOKENS,
  BUTTON_VARIANTS,
  DIVIDER_VARIANTS,
  EMAIL_BLOCKS,
  EMAIL_DOC_LIMITS,
  HEADING_LEVELS,
  MERGE_TAG_SUGGESTIONS,
  PADDING_Y_TOKENS,
  type AlignToken,
  type ButtonVariant,
  type DividerVariant,
  type EmailBlockDefinition,
  type EmailBlockType,
  type EmailDocJson,
  type EmailMarkJson,
  type EmailMarkType,
  type EmailNodeJson,
  type PaddingYToken,
} from "./types";

export {
  BLOCK_GROUP,
  EmailButton,
  EmailDivider,
  EmailDocument,
  EmailHeading,
  EmailImage,
  EmailLink,
  EmailMergeTag,
  EmailParagraph,
  EmailSection,
  emailExtensions,
  emailSchema,
  EMAIL_MARK_EXTENSIONS,
} from "./extensions";

export {
  COMMUNITY_EMAIL_TEMPLATES,
  COMMUNITY_TEMPLATE_CATEGORIES,
  communityTemplatesByCategory,
  findCommunityTemplate,
  type CommunityEmailTemplate,
  type CommunityTemplateCategory,
} from "./communityTemplates";

export {
  EMAIL_DOC_PRESETS,
  emptyEmailDoc,
  findEmailDocPreset,
  type EmailDocPreset,
} from "./presets";

export {
  assertValidEmailDoc,
  EmailDocValidationError,
  validateEmailDoc,
  type EmailDocIssue,
  type EmailDocValidationResult,
} from "./validate";

export {
  emailDocToPlainText,
  extractMergeTagPaths,
  renderEmailDoc,
  type RenderEmailDocOptions,
} from "./render";
