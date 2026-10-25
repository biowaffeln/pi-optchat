import { getMarkdownTheme, type ExtensionAPI, type Theme } from '@earendil-works/pi-coding-agent';
import { Box, Markdown, Text } from '@earendil-works/pi-tui';
import { noteLabel, type Note } from './peers.ts';
import { NOTE_TYPE, REPORT_TYPE, textContent, withoutFullChat } from './transcript.ts';

const HEAD = /^\[([0-9a-f]{8})\] (?:(Message from subagent \(still running\)): )?/;

/** Sent with a report: `count` subagent reports joined in one message, when one spawn's reports arrive together. */
export interface ReportDetails { count?: number }

/** Split "[id] Message from subagent (still running): body" into a short label and the body. */
export function reportParts(text: string, count = 1) {
  text = withoutFullChat(text); // For the agent: the user has the Agents page.
  if (count > 1) return { label: `${count} subagent reports`, body: text };
  const match = HEAD.exec(text);
  if (!match) return { label: 'subagent', body: text };
  const kind = match[2] === undefined ? 'report' : 'still running';
  return { label: `subagent ${match[1]} · ${kind}`, body: text.slice(match[0].length) };
}

/** The theme's neutral grey, darkened on dark themes so the box recedes behind the conversation. */
function darkBackground(theme: Theme) {
  const rgb = /^\x1b\[48;2;(\d+);(\d+);(\d+)m$/.exec(theme.getBgAnsi('toolPendingBg'))?.slice(1).map(Number);
  if (!rgb || rgb[0] + rgb[1] + rgb[2] > 3 * 128) return (text: string) => theme.bg('toolPendingBg', text);
  const open = `\x1b[48;2;${rgb.map(c => Math.round(c * 0.7)).join(';')}m`;
  return (text: string) => `${open}${text}\x1b[49m`;
}

/** Background traffic: a dark neutral box with dim text, so it never looks like something the user typed. */
export function reportBox(text: string, outputPad: number, theme: Theme, count?: number) {
  const { label, body } = reportParts(text, count);
  const box = new Box(outputPad, 1, darkBackground(theme));
  box.addChild(new Text(theme.fg('dim', `↳ ${label}`), 0, 0));
  box.addChild(new Markdown(body.trim(), 0, 0, getMarkdownTheme(), { color: text => theme.fg('muted', text) }));
  return box;
}
export function registerReportRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ReportDetails | undefined>(REPORT_TYPE, (message, { outputPad }, theme) => reportBox(textContent(message.content), outputPad, theme, message.details?.count));
}

/** Sent with peer notes: the notes the message holds, for their labels. */
export interface NoteDetails { notes?: Note[] }
/** Notes from other sessions, in the same receding box as reports: who sent each one and from where, then its text. */
export function noteBox(text: string, outputPad: number, theme: Theme, notes?: readonly Note[]) {
  const box = new Box(outputPad, 1, darkBackground(theme));
  const items = notes?.length ? notes.map(n => ({ label: noteLabel(n), body: n.text })) : [{ label: 'note from another session', body: text }];
  items.forEach(({ label, body }, k) => {
    box.addChild(new Text(theme.fg('dim', `${k ? '\n' : ''}↳ ${label}`), 0, 0));
    box.addChild(new Text(theme.fg('muted', body.trim()), 0, 0));
  });
  return box;
}
export function registerNoteRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<NoteDetails | undefined>(NOTE_TYPE, (message, { outputPad }, theme) => noteBox(textContent(message.content), outputPad, theme, message.details?.notes));
}
