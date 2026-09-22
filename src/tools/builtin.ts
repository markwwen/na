import { readTools } from "./read.js";
import { fileTools } from "./write.js";
import { commandTool } from "./command.js";
import type { AgentTool } from "../types.js";

export const builtinTools: AgentTool[] = [...readTools, ...fileTools, commandTool];
