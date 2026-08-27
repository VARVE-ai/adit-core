/**
 * @varveai/adit-plans — Project document templates and validation.
 */

export {
  DOC_TYPES,
  DOC_TYPE_IDS,
  extractH2Headings,
  extractSectionContents,
  classifyDocument,
  validateDocument,
  type DocTypeSpec,
  type DocValidationResult,
} from "./templates/doc-spec.js";

export { renderProjectOverviewTemplate } from "./templates/doc-project-overview.js";
export { renderArchitectureTemplate } from "./templates/doc-architecture.js";
export { renderApiReferenceTemplate } from "./templates/doc-api-reference.js";
export { renderDataModelTemplate } from "./templates/doc-data-model.js";
export { renderBusinessContextTemplate } from "./templates/doc-business-context.js";
export { renderConventionsTemplate } from "./templates/doc-conventions.js";
export {
  renderGenerateDocsPrompt,
  GENERATE_DOCS_PROMPT_PATH,
} from "./templates/prompt-generate-docs.js";
