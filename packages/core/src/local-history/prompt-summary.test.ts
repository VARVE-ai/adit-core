import { describe, expect, it } from "vitest";
import { hasCodexPromptContext, promptSummary, submittedPromptText } from "./prompt-summary.js";

const instructions =
  "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nPreserve the prototype copy.\n</INSTRUCTIONS>";
const environment =
  "<environment_context>\n<cwd>D:/work</cwd>\n</environment_context>";

describe("session prompt summaries", () => {
  it("removes a pure interruption wrapper but preserves actual text and quoted examples",()=>{
    expect(submittedPromptText('codex','<turn_aborted>interrupted</turn_aborted>')).toBeNull();
    expect(submittedPromptText('codex','<turn_aborted>interrupted</turn_aborted>\nActual request')).toBe('Actual request');
    expect(submittedPromptText('codex','Please explain <turn_aborted>')).toBe('Please explain <turn_aborted>');
  });
  it("keeps image-only submissions while excluding injected context and tool-result images",()=>{
    expect(submittedPromptText("codex",[{type:"input_text",text:"\n"},{type:"input_image",image_url:"data:private-image"}])).toBe("[Image]");
    expect(submittedPromptText("claude",[{type:"image",source:{data:"private"}},{type:"image",source:{data:"private"}}])).toBe("[Images: 2]");
    expect(submittedPromptText("codex",[{type:"input_text",text:environment},{type:"input_image",image_url:"private"}])).toBe("[Image]");
    expect(submittedPromptText("codex",[{type:"input_text",text:"Actual question"},{type:"input_image",image_url:"private"}])).toBe("Actual question");
    expect(submittedPromptText("codex",environment)).toBeNull();
    expect(submittedPromptText("claude",[{type:"tool_result",content:[{type:"image",source:{data:"private"}}]}])).toBeNull();
  });
  it.each(["codex", "traex", "augure-code"])(
    "skips injected context from %s",
    (provider) => {
      expect(promptSummary(provider, instructions + environment)).toBeNull();
      expect(promptSummary(provider, environment)).toBeNull();
      expect(hasCodexPromptContext(provider, instructions.slice(0, 70))).toBe(
        true,
      );
      expect(promptSummary(provider, instructions.slice(0, 70))).toBeNull();
    },
  );

  it("keeps the actual request after context, including multiple native content blocks", () => {
    expect(
      promptSummary("codex", [
        {
          type: "input_text",
          text: instructions.replace(
            "instructions\n",
            "instructions for D:/work\r\n",
          ),
        },
        { type: "input_text", text: environment },
        { type: "input_text", text: "  按原型实现提交页面，包括文案  " },
      ]),
    ).toBe("按原型实现提交页面，包括文案");
    expect(
      promptSummary("codex", environment + instructions + "\n修复提交记录"),
    ).toBe("修复提交记录");
  });

  it("preserves user discussions and quoted examples of the context markers", () => {
    for (const text of [
      "请修改 AGENTS.md instructions 中的规则",
      "请解释 <environment_context> 的作用",
      "```xml\n" + environment + "\n```",
      "# AGENTS.md instructions\n解释这个标题是什么意思",
    ])
      expect(promptSummary("codex", text)).toBe(text);
    expect(promptSummary("claude", environment)).toBe(environment);
  });

  it("ignores blank content, images and tool results, and bounds the summary length", () => {
    expect(promptSummary("codex", "\n\n")).toBeNull();
    expect(
      promptSummary("codex", [
        { type: "input_image", image_url: "data:example" },
      ]),
    ).toBeNull();
    expect(
      promptSummary("claude", [
        { type: "tool_result", content: "not a prompt" },
      ]),
    ).toBeNull();
    expect(
      promptSummary("codex", [
        { type: "tool_result", content: "not a prompt" },
        { type: "text", text: "a".repeat(300) },
      ]),
    ).toBe("a".repeat(240));
  });
});
