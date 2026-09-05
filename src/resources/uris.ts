/*
 * Every resource URI this server registers, as literals: the capabilities
 * object lists them, the docs contract checks prose against them, and a
 * test asserts the list equals what resources/list and
 * resources/templates/list return.
 */
export const CAPABILITIES_RESOURCE_URI = 'iris://capabilities';
export const PROOF_RESOURCE_URI = 'iris://proof';
export const DASHBOARD_SUMMARY_RESOURCE_URI = 'iris://dashboard/summary';
export const TRACE_RESOURCE_TEMPLATE = 'iris://traces/{trace_id}';
export const EVALUATION_RESOURCE_TEMPLATE = 'iris://evaluations/{id}';

export const RESOURCE_URIS = [
  CAPABILITIES_RESOURCE_URI,
  PROOF_RESOURCE_URI,
  DASHBOARD_SUMMARY_RESOURCE_URI,
  TRACE_RESOURCE_TEMPLATE,
  EVALUATION_RESOURCE_TEMPLATE,
] as const;

/** The URI of one stored trace / evaluation, from its template. */
export const traceUri = (traceId: string): string => TRACE_RESOURCE_TEMPLATE.replace('{trace_id}', traceId);
export const evaluationUri = (id: string): string => EVALUATION_RESOURCE_TEMPLATE.replace('{id}', id);

/** Fixed URIs (resources/list) versus templates (resources/templates/list). */
export const FIXED_RESOURCE_URIS = [CAPABILITIES_RESOURCE_URI, PROOF_RESOURCE_URI, DASHBOARD_SUMMARY_RESOURCE_URI] as const;
export const RESOURCE_TEMPLATES = [TRACE_RESOURCE_TEMPLATE, EVALUATION_RESOURCE_TEMPLATE] as const;
