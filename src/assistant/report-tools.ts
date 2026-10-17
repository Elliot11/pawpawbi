// The assistant's tools for changing the report: pages, files and datasets. Every change runs
// through `change` (index.ts), which asks the user first if they want that, records it so it
// can be undone, and tells the screens to update. Design: docs/assistant.md
import {
  deleteDataset,
  listDatasets,
  refreshDatasets,
  saveDataset,
} from '../report';
import {
  DATASET_NAME,
  createPage,
  createSite,
  deletePage,
  hasSite,
  readReport,
  readSiteFile,
  renamePage,
  writeSiteFile,
} from '../report-site';
import { SITE_TEMPLATES } from '../report-templates';
import { openProject } from '../projects';
import type { Target } from './changes';
import type { ToolCall, ToolSpec } from './types';

export interface ToolContext {
  /** Runs a change: recorded for Undo, linked to the tool call, screens told to update. */
  change: <T>(
    call: ToolCall,
    summary: string,
    targets: Target[],
    operation: () => Promise<T>,
  ) => Promise<T>;
  /** Shows a step of the workflow, and a report page, in the app. */
  show: (stage: 'data' | 'model' | 'visuals', pageId?: string) => void;
}

/** The report's own files (not its data), which page and file changes touch. */
const SITE: Target = { dir: 'report', exclude: ['data'] };
const datasetTargets = (name: string): Target[] => [
  { file: 'model/datasets.json' },
  { file: `report/data/${name}.json` },
];

const filesDir = () => openProject().filesDir;

function text(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): string {
  const value = input[key];
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || (!optional && !value.trim())) {
    throw new Error(`"${key}" is required.`);
  }
  return value;
}

async function requireSite() {
  if (!(await hasSite(filesDir()))) {
    throw new Error(
      'This project has no report yet. Create one with create_report first.',
    );
  }
}

/** A report file as people know it: `the page "Overview"` for a page, else its path. */
async function fileLabel(file: unknown): Promise<string> {
  const match = /^pages\/([0-9a-f-]{36})\.html$/.exec(String(file ?? ''));
  if (match) {
    const page = (await readReport(filesDir()).catch(() => null))?.pages.find(
      (p) => p.id === match[1],
    );
    if (page) return `the page "${page.title}"`;
  }
  return String(file ?? 'a report file');
}

/** A page ID from the model, which may also give it as "pages/<id>.html" or "<id>.html". */
function pageId(input: Record<string, unknown>) {
  return text(input, 'page_id')
    .trim()
    .replace(/^pages\//, '')
    .replace(/\.html$/, '');
}

async function pageTitle(id: string) {
  const page = (await readReport(filesDir())).pages.find((p) => p.id === id);
  if (!page)
    throw new Error(
      `There's no page with the ID ${id}. get_report lists the pages.`,
    );
  return page.title;
}

function datasetName(input: Record<string, unknown>) {
  const name = text(input, 'name');
  if (!DATASET_NAME.test(name)) {
    throw new Error(
      'Dataset names use lowercase letters, digits and underscores, starting with a letter, e.g. revenue_by_month.',
    );
  }
  return name;
}

export function reportTools(ctx: ToolContext): ToolSpec[] {
  const step = 'visuals' as const;
  return [
    {
      name: 'create_report',
      description:
        'Adds the default report (a landing page, styles, the chart library and one empty "Overview" page) to a project that has none. Projects made before reports existed have none.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      change: true,
      step,
      describe: () => 'Add a report to the project',
      run: async (_input, call) => {
        if (await hasSite(filesDir()))
          return 'The project already has a report.';
        const report = await ctx.change(call, 'Added a report', [SITE], () =>
          createSite(filesDir(), openProject().name, SITE_TEMPLATES),
        );
        return report;
      },
    },
    {
      name: 'create_page',
      description:
        'Adds a page to the report, at the end. Without html it starts from the empty page template; with html, that becomes the page (a complete HTML document, written as the report guide describes). Returns its id and path.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Shown in the navigation, at most 80 characters.',
          },
          html: {
            type: 'string',
            description: 'The whole page, if you have it.',
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: (input) => `Add a page "${String(input.title ?? '')}"`,
      run: async (input, call) => {
        await requireSite();
        const title = text(input, 'title');
        const html = text(input, 'html', true);
        // Models (small ones especially) tend to add a new page rather than edit the one asked
        // for; two pages with one name would confuse the user too.
        const existing = (await readReport(filesDir())).pages.find(
          (p) => p.title.toLowerCase() === title.trim().toLowerCase(),
        );
        if (existing) {
          throw new Error(
            `There's already a page called "${existing.title}" (pages/${existing.id}.html). To change it, read it with read_report_file and edit it with edit_report_file. For a new page, choose a different title.`,
          );
        }
        const page = await ctx.change(
          call,
          `Added the page "${title}"`,
          [SITE],
          async () => {
            const created = await createPage(filesDir(), title, SITE_TEMPLATES);
            if (html)
              await writeSiteFile(filesDir(), `pages/${created.id}.html`, html);
            return created;
          },
        );
        return { ...page, path: `pages/${page.id}.html` };
      },
    },
    {
      name: 'rename_page',
      description:
        "Changes a page's title in the navigation. Its heading is part of its HTML: change that with edit_report_file.",
      parameters: {
        type: 'object',
        properties: { page_id: { type: 'string' }, title: { type: 'string' } },
        required: ['page_id', 'title'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: (input) => `Rename a page to "${String(input.title ?? '')}"`,
      run: async (input, call) => {
        const id = pageId(input);
        const old = await pageTitle(id);
        const title = text(input, 'title');
        await ctx.change(call, `Renamed "${old}" to "${title}"`, [SITE], () =>
          renamePage(filesDir(), id, title),
        );
        return 'Renamed.';
      },
    },
    {
      name: 'delete_page',
      description: 'Deletes a page from the report.',
      parameters: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: async (input) =>
        `Delete ${await fileLabel(`pages/${String(input.page_id)}.html`)}`,
      run: async (input, call) => {
        const id = pageId(input);
        const title = await pageTitle(id);
        await ctx.change(call, `Deleted the page "${title}"`, [SITE], () =>
          deletePage(filesDir(), id),
        );
        return 'Deleted.';
      },
    },
    {
      name: 'write_report_file',
      description:
        'Writes a whole page, stylesheet or script of the report, replacing it if it exists, e.g. "pages/<id>.html" or "assets/report.css". For small changes to an existing file, use edit_report_file instead. Files in data/ come from datasets and can\'t be written.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'The whole file.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: async (input) => `Write ${await fileLabel(input.path)}`,
      run: async (input, call) => {
        await requireSite();
        const file = text(input, 'path');
        const content = text(input, 'content', true);
        await ctx.change(call, `Wrote ${await fileLabel(file)}`, [SITE], () =>
          writeSiteFile(filesDir(), file, content),
        );
        return 'Written.';
      },
    },
    {
      name: 'edit_report_file',
      description:
        'Changes part of a page, stylesheet or script: replaces the exact text `find` with `replace`. `find` must appear exactly once in the file, so include enough surrounding text to make it unique. Read the file first (read_report_file) to copy the text exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: {
            type: 'string',
            description: 'Text currently in the file, copied exactly.',
          },
          replace: { type: 'string', description: 'What to put in its place.' },
        },
        required: ['path', 'find', 'replace'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: async (input) => `Edit ${await fileLabel(input.path)}`,
      run: async (input, call) => {
        await requireSite();
        const file = text(input, 'path');
        const find = text(input, 'find');
        const replace = text(input, 'replace', true);
        const current = await readSiteFile(filesDir(), file);
        const count = current.split(find).length - 1;
        if (count === 0) {
          throw new Error(
            `That text isn't in ${file}. Read the file again and copy the text exactly, including spaces and line breaks.`,
          );
        }
        if (count > 1) {
          throw new Error(
            `That text appears ${count} times in ${file}. Include more of the surrounding text so it matches once.`,
          );
        }
        await ctx.change(call, `Edited ${await fileLabel(file)}`, [SITE], () =>
          writeSiteFile(
            filesDir(),
            file,
            current.replace(find, () => replace),
          ),
        );
        return 'Edited.';
      },
    },
    {
      name: 'save_dataset',
      description:
        'Creates or changes a dataset: a named SELECT query whose result the report publishes as data/<name>.json for its charts. Runs the query and writes the data; fails with the error if the query does. Group the data in the query: only what it returns is published.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Lowercase letters, digits and underscores, e.g. revenue_by_month.',
          },
          sql: {
            type: 'string',
            description: 'One SELECT query (DuckDB SQL) over the tables.',
          },
        },
        required: ['name', 'sql'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: (input) => `Save the dataset ${String(input.name ?? '')}`,
      run: async (input, call) => {
        await requireSite();
        const name = datasetName(input);
        const sql = text(input, 'sql');
        const exists = (await listDatasets()).some((d) => d.name === name);
        const saved = await ctx.change(
          call,
          `${exists ? 'Changed' : 'Created'} the dataset ${name}`,
          datasetTargets(name),
          () => saveDataset(name, sql),
        );
        return {
          name: saved.name,
          rows: saved.rows,
          file: `data/${name}.json`,
        };
      },
    },
    {
      name: 'delete_dataset',
      description:
        'Deletes a dataset and its data file. Charts that use it will show an error.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      change: true,
      step,
      describe: (input) => `Delete the dataset ${String(input.name ?? '')}`,
      run: async (input, call) => {
        const name = datasetName(input);
        if (!(await listDatasets()).some((d) => d.name === name)) {
          throw new Error(`There's no dataset called ${name}.`);
        }
        await ctx.change(
          call,
          `Deleted the dataset ${name}`,
          datasetTargets(name),
          () => deleteDataset(name),
        );
        return 'Deleted.';
      },
    },
    {
      name: 'refresh_datasets',
      description:
        "Rewrites every dataset's data from the tables as they are now, e.g. after changing a table. Returns each dataset's rows or error.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      change: true,
      step,
      describe: () => "Update the report's data",
      run: async (_input, call) => {
        await requireSite();
        const datasets = await ctx.change(
          call,
          "Updated the report's data",
          [{ file: 'model/datasets.json' }, { dir: 'report/data' }],
          () => refreshDatasets(),
        );
        return datasets.map((d) => ({
          name: d.name,
          rows: d.rows,
          error: d.error,
        }));
      },
    },
    {
      name: 'show_page',
      description:
        'Shows a report page to the user in the app (switching to Build visuals). Use it after building or changing a page, so they can see the result.',
      parameters: {
        type: 'object',
        properties: { page_id: { type: 'string' } },
        required: ['page_id'],
        additionalProperties: false,
      },
      step,
      describe: () => 'Showing the page',
      run: async (input) => {
        const id = pageId(input);
        await pageTitle(id);
        ctx.show('visuals', id);
        return 'Shown.';
      },
    },
  ];
}
