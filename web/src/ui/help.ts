import { h } from './dom';
import { openModal } from './modal';
import './topbar.css';

const SHORTCUTS: Array<[keys: string, does: string]> = [
  ['+ and -', 'Zoom in and out'],
  ['0', 'Fit the whole board'],
  ['Arrow keys', 'Pan the board'],
  ['Enter', 'Open the selected tile in focus mode'],
  ['Esc', 'Leave focus mode, or stop using a tile'],
];

const section = (title: string, ...content: Array<Node | string>) =>
  h('section', { class: 'help-section' }, h('h3', null, title), ...content);

/** boardHost is the host of the site the board runs on, for example jacobl-h.github.io. */
export function openHelp(boardHost: string): void {
  const body = h(
    'div',
    { class: 'help' },
    section(
      'Post to a tile',
      h('p', null, 'Click an empty tile, choose Link or HTML file, and press Post. Your name goes above the tile. You can rename or replace any tile. Earlier versions stay in History, so nothing is lost.'),
    ),
    section(
      'Upload an HTML file',
      h('p', null, "In the post dialog, choose HTML file, then pick a file, drop one on the dialog or paste the code. It must be one file of up to 1 MB. Scripts run, but the page can't use cookies or saved browser data."),
    ),
    section(
      'Show a Claude artifact',
      h(
        'p',
        null,
        'Publish the artifact in Claude, then open Publish → Get embed code and add ',
        h('code', null, boardHost),
        ' to Allowed domains. Paste its claude.ai/public/artifacts link into a tile and it runs live.',
      ),
      h('p', null, "Artifacts shared with the Share button can't be shown live. Download the artifact's HTML file and upload it instead."),
    ),
    section(
      'Focus mode',
      h('p', null, "Keep zooming in on a tile after it fills the screen, or select it and press Enter, and it fills the whole page. Use the Back button, Esc or your browser's back button to return to the board."),
    ),
    section(
      'Move around',
      h('p', null, 'Scroll to zoom, drag to pan, double-click a tile to zoom to it. Click a running tile to use it.'),
      h(
        'dl',
        { class: 'help-keys' },
        ...SHORTCUTS.flatMap(([keys, does]) => [h('dt', null, h('kbd', null, keys)), h('dd', null, does)]),
      ),
    ),
  );
  openModal({ title: 'How the board works', dialog: 'help', body });
}
