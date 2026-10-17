// The guided report-building workflow the assistant walks the user through.
import type { WorkflowStage } from './shared/types';

export const STAGES: { id: WorkflowStage; label: string }[] = [
  { id: 'data', label: 'Add data' },
  { id: 'model', label: 'Model data' },
  { id: 'visuals', label: 'Build visuals' },
];

export const INTRO_MESSAGE = `Hi! Let's build your report together. We'll work through three steps:

1. Add data: connect a file, spreadsheet or database.
2. Model the data: I'll check how your tables fit together and ask you to clarify anything ambiguous, like how two tables join or how dates should be grouped.
3. Build visuals: tell me what you want to see and I'll add charts to the canvas on the right.

To start, where does your data live? For example, "a CSV export of monthly sales" or "our Postgres orders database".`;

/**
 * Placeholder responder that just advances through the workflow stages.
 * Replace this with a call to a real model once one is connected.
 */
export function replyTo(stage: WorkflowStage): {
  text: string;
  stage: WorkflowStage;
} {
  switch (stage) {
    case 'data':
      return {
        stage: 'model',
        text: `Thanks. Use the Add data screen on the right to connect to it: pick a connector, fill in its settings, then choose the tables to load. (I can't set up connections for you yet.)

Step 2: Model the data. Once your data is loaded, I'll look at how the tables relate and flag anything unclear, such as which column links orders to customers or whether "date" means order date or ship date.

Is there anything you already know about the data that I should keep in mind?`,
      };
    case 'model':
      return {
        stage: 'visuals',
        text: `Got it, I'll keep that in mind.

Step 3: Build visuals. Tell me what you'd like to see, for example "monthly revenue by region" or "top 10 customers this quarter". Visuals will appear on the canvas.`,
      };
    case 'visuals':
      return {
        stage: 'visuals',
        text: `Generating visuals isn't connected yet. When it is, this is where your chart would be added to the canvas.`,
      };
  }
}
