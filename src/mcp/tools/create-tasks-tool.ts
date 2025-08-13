import { z } from "zod";
import { FramelinkService, type ToolResult } from "~/services/framelink.js";

const taskSchema = z.object({
  code: z
    .string()
    .min(2, "Code is required")
    .regex(
      /^[A-Z]{2,5}(-\d+)?$/,
      "Code must be in format CODE or CODE-NUMBER (e.g., FRA or FRA-1). Code alone will add a task at the top level of the project. Code-number will add the task as a child of the task with the given code.",
    ),
  title: z.string().min(1, "Task title is required").max(255, "Task title too long"),
  description: z.string().optional().nullable(),
  type: z.enum(["feature", "task", "question"]).default("task"),
  status: z.enum(["pending", "in-progress", "done"]).default("pending"),
});

const parameters = {
  tasks: z
    .array(taskSchema)
    .min(1, "At least one task is required")
    .describe("Array of tasks to create"),
};

const parametersSchema = z.object(parameters);
export type CreateTasksParams = z.infer<typeof parametersSchema>;

async function createTasksHandler(
  { tasks }: CreateTasksParams,
  framelinkService: FramelinkService,
): Promise<ToolResult> {
  return await framelinkService.request(
    "/tasks",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    },
    async (data) => {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );
}

export const createTasksTool = {
  name: "create_tasks",
  description: "Create one or more Framelink tasks",
  parameters,
  handler: createTasksHandler,
} as const;
