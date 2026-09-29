import { CURSOR } from '@class-board/shared/constants';
import { slotName } from '@class-board/shared/slots';
import type { Person } from '@class-board/shared/types';
import type { CursorImage, RemoteCursorsApi, RemoteCursorsDeps, Unsubscribe } from '../contracts';
import { h } from '../ui/dom';
import { createInterpolator, type Interpolator } from './interpolate';
import { cursorImage, tagTextColor } from './render';
import './cursors.css';

/** Optional test seams on top of the contract's deps. */
export interface RemoteCursorsSeams extends RemoteCursorsDeps {
  raf?: (fn: () => void) => number;
  caf?: (id: number) => void;
}

interface Entry {
  el: HTMLElement;
  img: HTMLElement;
  tag: HTMLElement;
  interp: Interpolator;
  person: Person;
  profileKey: string;
  presenceKey: string;
  /** Last time this person moved, joined or changed what they're doing. */
  lastActive: number;
  written: { visible: boolean; transform: string; idle: boolean; tagText: string };
}

const IMAGE_CACHE_LIMIT = 200;

export function createRemoteCursors(deps: RemoteCursorsSeams): RemoteCursorsApi {
  const { layer, camera, state } = deps;
  const now = deps.now ?? (() => Date.now());
  const raf = deps.raf ?? ((fn) => requestAnimationFrame(fn));
  const caf = deps.caf ?? ((id) => cancelAnimationFrame(id));

  const entries = new Map<string, Entry>();
  const images = new Map<string, Promise<CursorImage>>();
  let subscriptions: Unsubscribe[] = [];
  let frame: number | null = null;
  let running = false;

  function imageFor(key: string, person: Person): Promise<CursorImage> {
    let image = images.get(key);
    if (!image) {
      if (images.size >= IMAGE_CACHE_LIMIT) images.clear();
      image = cursorImage(person.profile);
      images.set(key, image);
    }
    return image;
  }

  function applyProfile(entry: Entry, person: Person, key: string): void {
    entry.profileKey = key;
    entry.tag.style.background = person.profile.color;
    entry.tag.style.color = tagTextColor(person.profile.color);
    void imageFor(key, person).then((image) => {
      if (entry.profileKey !== key) return;
      entry.img.setAttribute('src', image.url);
      entry.img.style.left = `${-image.tipX}px`;
      entry.img.style.top = `${-image.tipY}px`;
    });
  }

  function create(person: Person): Entry {
    const img = h('img', { class: 'cursor-img', attrs: { alt: '', draggable: 'false', width: String(CURSOR.imageSize), height: String(CURSOR.imageSize) } });
    const tag = h('span', { class: 'cursor-tag' });
    const el = h('div', { class: 'cursor', dataset: { person: person.id }, hidden: true }, img, tag);
    layer.append(el);
    const entry: Entry = {
      el, img, tag, person,
      interp: createInterpolator(),
      profileKey: '',
      presenceKey: JSON.stringify(person.presence),
      lastActive: now(),
      written: { visible: false, transform: '', idle: false, tagText: '' },
    };
    entries.set(person.id, entry);
    applyProfile(entry, person, JSON.stringify(person.profile));
    return entry;
  }

  function update(entry: Entry, person: Person): void {
    entry.person = person;
    const profileKey = JSON.stringify(person.profile);
    if (profileKey !== entry.profileKey) applyProfile(entry, person, profileKey);
    const presenceKey = JSON.stringify(person.presence);
    if (presenceKey !== entry.presenceKey) {
      entry.presenceKey = presenceKey;
      entry.lastActive = now();
    }
  }

  function reconcile(): void {
    const you = state.you();
    const present = new Set<string>();
    for (const person of state.people()) {
      if (person.id === you) continue;
      present.add(person.id);
      const entry = entries.get(person.id);
      if (entry) update(entry, person);
      else create(person);
    }
    for (const [id, entry] of entries) {
      if (present.has(id)) continue;
      entry.el.remove();
      entries.delete(id);
    }
  }

  function onMoves(moves: ReadonlyArray<readonly [string, number, number]>): void {
    const you = state.you();
    const t = now();
    for (const [id, x, y] of moves) {
      if (id === you) continue;
      let entry = entries.get(id);
      if (!entry) {
        const person = state.person(id);
        if (!person) continue;
        entry = create(person);
      }
      entry.interp.push(t, x, y);
      entry.lastActive = t;
    }
  }

  function tick(): void {
    const t = now();
    for (const entry of entries.values()) {
      const { presence, profile } = entry.person;
      let point: { x: number; y: number } | null = null;
      let tagText = profile.name;
      if (presence.at === 'tile') {
        const rect = camera.slotScreenRect(presence.slot);
        point = { x: rect.x, y: rect.y };
        tagText = `${profile.name} · ${presence.mode} ${slotName(presence.slot)}`;
      } else if (presence.at === 'board') {
        const sample = entry.interp.sample(t);
        if (sample) point = camera.toScreen(sample.x, sample.y);
      }

      const visible = point !== null;
      // A cursor parked on a tile keeps its "using C4" tag readable, so only board cursors fade.
      const idle = visible && presence.at === 'board' && t - entry.lastActive > CURSOR.idleMs;
      const w = entry.written;
      if (visible !== w.visible) {
        entry.el.hidden = !visible;
        w.visible = visible;
      }
      if (point) {
        const transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
        if (transform !== w.transform) {
          entry.el.style.transform = transform;
          w.transform = transform;
        }
      }
      if (idle !== w.idle) {
        entry.el.classList.toggle('is-idle', idle);
        entry.el.style.opacity = idle ? String(CURSOR.idleOpacity) : '';
        w.idle = idle;
      }
      if (tagText !== w.tagText) {
        entry.tag.textContent = tagText;
        w.tagText = tagText;
      }
    }
  }

  function loop(): void {
    tick();
    frame = raf(loop);
  }

  return {
    start() {
      if (running) return;
      running = true;
      subscriptions = [
        state.on('cursors', onMoves),
        state.on('people', reconcile),
        state.on('snapshot', reconcile),
        camera.onChange(tick),
      ];
      reconcile();
      loop();
    },

    stop() {
      if (!running) return;
      running = false;
      for (const off of subscriptions) off();
      subscriptions = [];
      if (frame !== null) caf(frame);
      frame = null;
    },
  };
}
