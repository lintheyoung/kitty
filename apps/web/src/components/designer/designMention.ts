import { displayNet } from "@t3tools/shared/kicad/pick";

/** How a part or net picked in the designer is named in a message to the agent. */
export function designMention(input: {
  readonly ref?: string | undefined;
  readonly value?: string | undefined;
  readonly net?: string | undefined;
  /** The drawing's file, relative to the workspace. */
  readonly file: string;
}): string | undefined {
  const part = input.ref ? `${input.ref}${input.value ? ` (${input.value})` : ""}` : undefined;
  const net = input.net ? `net ${displayNet(input.net)}` : undefined;
  const subject = [part, net].filter(Boolean).join(", ");
  return subject === "" ? undefined : `${subject} in ${input.file}`;
}

/** The prompt with the mention at its end; unchanged when it is already there. */
export function withMention(prompt: string, mention: string): string {
  if (prompt.includes(mention)) return prompt;
  const before = prompt.trimEnd();
  return `${before}${before === "" ? "" : "\n"}About ${mention}: `;
}
