/**
 * Claude Code Session Init Form — `AskUserQuestion` tool_use.
 *
 * Claude Code 原生交互 form：
 *   - Tool name: `AskUserQuestion`
 *   - Options: `{ label, description }` 结构体，2-4 个硬限制
 *   - Protocol: 仅 Anthropic SSE
 *   - ID prefix: `toolu_cc_session_init_`
 *   - 分页: 每页 3 个 agent + 1 个"更多→"/SKIP 槽位
 *
 * 不含任何 CodeBuddy 逻辑。
 */

import type { TeamOption } from "../types.js";
import { computePagination, CC_MAX_OPTIONS as CC_MAX_OPTIONS_SHARED } from "./pagination.js";
import {
  ASSET_CONFIRM_FORM_TITLE,
  ASSET_CONFIRM_HEADER,
  ASSET_CONFIRM_NO,
  ASSET_CONFIRM_NO_DESC,
  ASSET_CONFIRM_QUESTION,
  ASSET_CONFIRM_YES,
  ASSET_CONFIRM_YES_DESC,
  agentSelectQuestion,
  AGENT_TASK_FORM_TITLE,
  containsSessionInitFormTitle,
  formatPageSuffix,
  MORE_LABEL,
  moreAgentsDescription,
  moreTasksDescription,
  RETRY_FORM_TITLE,
  SKIP_LABEL,
  taskSelectQuestion,
  TEAM_FORM_TITLE,
  TEAM_SELECT_QUESTION,
} from "../labels.js";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TOOL_NAME = "AskUserQuestion";
export const TOOLCALL_PREFIX = "toolu_cc_session_init_";

export {
  TEAM_FORM_TITLE,
  AGENT_TASK_FORM_TITLE,
  RETRY_FORM_TITLE,
  SKIP_LABEL,
  MORE_LABEL,
  ASSET_CONFIRM_YES,
  ASSET_CONFIRM_NO,
  ASSET_CONFIRM_FORM_TITLE,
};

/** Returns true if the given string contains any CC form title marker. */
export function containsFormTitle(s: string): boolean {
  return containsSessionInitFormTitle(s);
}

const CC_MAX_OPTIONS = CC_MAX_OPTIONS_SHARED;

/** Returns true if a tool_use id belongs to a CC session-init form. */
export function isSessionInitToolCallId(id: string): boolean {
  return id.startsWith(TOOLCALL_PREFIX);
}

// ── Form Data ──────────────────────────────────────────────────────────────────

export type FormStage = "asset_confirm" | "team" | "agent_select" | "agent_task" | "task_select";

export interface FormData {
  teams: TeamOption[];
  stage: FormStage;
  selectedTeamId?: string;
  /** Claude Code 分页：当前 agent 页码 (0-based) */
  pageIndex?: number;
  retry?: boolean;
  stream?: boolean;
  modelId?: string;
}

// ── Claude Code AskUserQuestion input schema ───────────────────────────────────

interface CCAskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

function buildAskUserQuestionArgs(data: FormData): { questions: CCAskQuestion[] } {
  const { teams, stage, selectedTeamId, retry } = data;
  const titlePrefix = retry ? "⚠️ " : "";
  const questions: CCAskQuestion[] = [];

  if (stage === "asset_confirm") {
    questions.push({
      question: titlePrefix + ASSET_CONFIRM_QUESTION,
      header: ASSET_CONFIRM_HEADER,
      options: [
        { label: ASSET_CONFIRM_YES, description: ASSET_CONFIRM_YES_DESC },
        { label: ASSET_CONFIRM_NO, description: ASSET_CONFIRM_NO_DESC },
      ],
      multiSelect: false,
    });
    return { questions };
  }

  if (stage === "team") {
    // Team options: 只列真实 team。主动"跳过"入口只在 asset_confirm 阶段，后续
    // 阶段"异常/未识别"由 init.ts 兜底 bypass。
    //
    // 调用方（init.ts）保证 teams.length ≥ 2 — 单 team 会被 auto-select 跳过，
    // 根本不会走到 team form。form builder 不再兜底占位。
    // description 留空 —— label 已含 team 名 + id 后缀，重复一遍 "Team: name"
    // 只是噪音。
    // Team 阶段目前不分页 —— 最多渲染 CC_MAX_OPTIONS 个 team（超过的静默截断，
    // 属于 pre-existing 限制，本次未处理）。
    const teamOpts = teams.slice(0, CC_MAX_OPTIONS).map((t) => ({
      label: `${t.team_name} (${t.team_id.slice(-8)})`,
      description: "",
    }));
    if (teamOpts.length < 2) {
      throw new Error(
        `[cc form] team stage requires ≥2 teams (got ${teamOpts.length}). ` +
          `Caller must auto-select when teams.length === 1.`,
      );
    }
    questions.push({
      question: titlePrefix + TEAM_SELECT_QUESTION,
      header: "Team",
      options: teamOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "agent_select" or "agent_task" (agent_task = no SKIP on last page)
  const team = teams.find((t) => t.team_id === selectedTeamId) ?? teams[0];
  if (!team) return { questions };

  if (stage === "agent_select" || stage === "agent_task") {
    const pageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.agents.length, pageIndex);
    const slice = team.agents.slice(page.start, page.end);

    // 只保留 agent 自身描述（有信息量），删掉 "(选完 agent 后可选 N 个任务)" /
    // "(无任务)" 的尾巴 —— 用户此时正在选 agent，任务数量提示既不影响决策
    // 也占屏。agent 若无自定义描述则 description 留空，不再回退到 "Agent: 名"
    // （label 已经有名字）。
    const combinedOptions: Array<{ label: string; description: string }> = slice.map((a) => ({
      label: `${a.agent_name} (${a.agent_id.slice(-8)})`,
      description: a.description ?? "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      combinedOptions.push({ label: MORE_LABEL, description: moreAgentsDescription(remaining) });
    }
    // 末页不再追加 SKIP：主动跳过只在 asset_confirm 提供；后续阶段"异常/未识别"
    // 由 init.ts 兜底 bypass。
    //
    // pagination.ts 保证每页真实项数 ≥ 2（total > 4 时；total ≤ 4 时单页含全部
    // 4 个 slot 铺满，无 MORE）；此处不该再收到 <2 的 combinedOptions。
    if (combinedOptions.length < 2) {
      throw new Error(
        `[cc form] agent page ${pageIndex} has ${combinedOptions.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const pageSuffix = formatPageSuffix(pageIndex, page.totalPages);
    questions.push({
      question: titlePrefix + agentSelectQuestion(team.team_name, pageSuffix),
      header: page.totalPages > 1 ? `Agent ${pageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Agent",
      options: combinedOptions.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });
    return { questions };
  }

  // stage === "task_select"
  if (!team) return { questions };

  if (stage === "task_select") {
    const taskPageIndex = Math.max(0, data.pageIndex ?? 0);
    const page = computePagination(team.tasks.length, taskPageIndex);
    const taskSlice = team.tasks.slice(page.start, page.end);

    // description 留空 —— label 已含 task 名 + id 后缀，"Task: name" 只是噪音。
    // 虚拟兜底条目（isDefault）不拼 id 后缀，反正只有一个不会重名歧义。
    const taskOpts: Array<{ label: string; description: string }> = taskSlice.map((t) => ({
      label: t.isDefault
        ? t.task_name
        : `${t.task_name} (${t.task_id.slice(-8)})`,
      description: "",
    }));

    if (!page.isLastPage) {
      const remaining = page.total - page.end;
      taskOpts.push({
        label: MORE_LABEL,
        description: moreTasksDescription(remaining),
      });
    }

    // 同 agent 阶段：pagination.ts 保证 count ≥ 2，此处 <2 说明分页器有 bug。
    if (taskOpts.length < 2) {
      throw new Error(
        `[cc form] task page ${taskPageIndex} has ${taskOpts.length} option(s); ` +
          `pagination.ts should have avoided a solo last page.`,
      );
    }

    const taskPageSuffix = formatPageSuffix(taskPageIndex, page.totalPages);
    questions.push({
      question: titlePrefix + taskSelectQuestion(team.team_name, taskPageSuffix),
      header: page.totalPages > 1 ? `Task ${taskPageIndex + 1}/${page.totalPages}`.slice(0, 12) : "Task",
      options: taskOpts.slice(0, CC_MAX_OPTIONS),
      multiSelect: false,
    });

    return { questions };
  }

  return { questions };
}

// ── Form Builder ───────────────────────────────────────────────────────────────

/**
 * Build a Claude Code `AskUserQuestion` fake form response.
 * Always Anthropic SSE streaming (Claude Code only speaks Anthropic).
 */
export function buildFormResponse(data: FormData): Response {
  const model = data.modelId ?? "unknown";
  const msgId = "msg_cc_session_init_" + Date.now();
  const toolUseId = TOOLCALL_PREFIX + Date.now();
  const input = buildAskUserQuestionArgs(data);
  const inputJson = JSON.stringify(input);

  const encoder = new TextEncoder();
  const sse = (event: string, d: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(sse("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));

      controller.enqueue(sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: TOOL_NAME,
          input: {},
        },
      }));

      controller.enqueue(sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: inputJson },
      }));

      controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));

      controller.enqueue(sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      }));

      controller.enqueue(sse("message_stop", { type: "message_stop" }));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
