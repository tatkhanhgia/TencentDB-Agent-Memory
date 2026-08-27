/**
 * User-facing session-init copy (English).
 * Legacy Chinese markers are kept for history scan / extractor backward compat.
 */

export const DEFAULT_TASK_LABEL = "No task for this session";

export const TEAM_FORM_TITLE = "Session Setup — Select Team";
export const AGENT_TASK_FORM_TITLE = "Session Setup — Select Agent & Task";
export const COMBINED_FORM_TITLE = "Session Setup — Select Team / Agent / Task";
export const RETRY_FORM_TITLE = "Could not recognize your choice, please try again";

export const SKIP_LABEL = "Skip binding (no injection, continue)";

export const ASSET_CONFIRM_YES = "Yes, bind team assets";
export const ASSET_CONFIRM_NO = "No, skip for this session";
export const ASSET_CONFIRM_FORM_TITLE = "Session Setup — Bind team assets?";

export const MORE_LABEL = "More →";
export const NO_MORE_LABEL = "(No more options)";
export const NO_MORE_DESC = "Choosing this skips injection and continues";
export const SKIP_BINDING_DESC = "Skip binding and continue";

/** Legacy aliases used by shared form.ts */
export const SESSION_INIT_TEAM_FORM_TITLE = TEAM_FORM_TITLE;
export const SESSION_INIT_AGENT_TASK_FORM_TITLE = AGENT_TASK_FORM_TITLE;
export const SESSION_INIT_FORM_TITLE = COMBINED_FORM_TITLE;
export const SESSION_INIT_RETRY_FORM_TITLE = RETRY_FORM_TITLE;

/** Legacy Chinese labels (older sessions / history rebuild) */
export const LEGACY_DEFAULT_TASK_LABEL = "本次不关联任务";
export const LEGACY_SKIP_LABEL = "本次不关联（跳过注入，直接放行）";
export const LEGACY_ASSET_CONFIRM_YES = "是，关联团队资产";
export const LEGACY_ASSET_CONFIRM_NO = "否，本次不关联";
export const LEGACY_SESSION_INIT_TITLE_MARKER = "会话初始化";

export const SESSION_INIT_TITLE_MARKER = "Session Setup";

export const ASSET_CONFIRM_QUESTION = "Do you want to bind team assets for this conversation?";
export const ASSET_CONFIRM_HEADER = "Assets";
export const ASSET_CONFIRM_YES_DESC = "Pick Team / Agent / Task and inject team context";
export const ASSET_CONFIRM_NO_DESC = "Skip injection and continue";

export const TEAM_SELECT_QUESTION = "Select the Team for this session:";

export function agentSelectQuestion(teamName: string, pageSuffix = ""): string {
  return `Select an Agent under "${teamName}"${pageSuffix}:`;
}

export function taskSelectQuestion(teamName: string, pageSuffix = ""): string {
  return `Select a task under "${teamName}"${pageSuffix}:`;
}

export function formatPageSuffix(pageIndex: number, totalPages: number): string {
  return totalPages > 1 ? ` (page ${pageIndex + 1}/${totalPages})` : "";
}

export function moreAgentsDescription(remaining: number): string {
  return `See next page (${remaining} more Agents)`;
}

export function moreTasksDescription(remaining: number): string {
  return `See next page (${remaining} more tasks)`;
}

const FORM_TITLE_MARKERS = [
  TEAM_FORM_TITLE,
  AGENT_TASK_FORM_TITLE,
  COMBINED_FORM_TITLE,
  RETRY_FORM_TITLE,
  ASSET_CONFIRM_FORM_TITLE,
  // legacy Chinese titles
  "会话初始化 — 选择 Team",
  "会话初始化 — 选择 Agent 与任务",
  "会话初始化 — 选择 Team / Agent / 任务",
  "未能识别选择，请重新选择",
  "会话初始化 — 是否关联团队资产",
] as const;

/** Returns true if the string contains any session-init form title (EN or legacy ZH). */
export function containsSessionInitFormTitle(s: string): boolean {
  return FORM_TITLE_MARKERS.some((m) => s.includes(m));
}
