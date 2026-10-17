// The files a new report site starts with (src/report-template/), bundled into the app.
import type { SiteTemplates } from './report-site';
import charts from './report-template/assets/charts.js?raw';
import css from './report-template/assets/report.css?raw';
import index from './report-template/index.html?raw';
import page from './report-template/page.html?raw';

export const SITE_TEMPLATES: SiteTemplates = { index, page, css, charts };
