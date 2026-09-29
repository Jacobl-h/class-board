import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../src/util/emitter';

interface Events {
  count: number;
  ready: undefined;
  name: string;
}

afterEach(() => vi.restoreAllMocks());

describe('createEmitter', () => {
  it('delivers a payload to every listener of that event only', () => {
    const e = createEmitter<Events>();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    e.on('count', a);
    e.on('count', b);
    e.on('name', other);
    e.emit('count', 3);
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
    expect(other).not.toHaveBeenCalled();
  });

  it('lets an event with an undefined payload be emitted with no argument', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    e.on('ready', fn);
    e.emit('ready');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it('stops delivering after the returned unsubscribe is called', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    const off = e.on('count', fn);
    e.emit('count', 1);
    off();
    e.emit('count', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is safe to unsubscribe while emitting', () => {
    const e = createEmitter<Events>();
    const calls: string[] = [];
    const offFirst = e.on('count', () => {
      calls.push('first');
      offFirst();
    });
    e.on('count', () => calls.push('second'));
    e.emit('count', 1);
    e.emit('count', 2);
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('keeps delivering to other listeners when one throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = createEmitter<Events>();
    const after = vi.fn();
    e.on('count', () => {
      throw new Error('boom');
    });
    e.on('count', after);
    e.emit('count', 1);
    expect(after).toHaveBeenCalledWith(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('clear removes every listener', () => {
    const e = createEmitter<Events>();
    const fn = vi.fn();
    e.on('count', fn);
    e.on('name', fn);
    e.clear();
    e.emit('count', 1);
    e.emit('name', 'x');
    expect(fn).not.toHaveBeenCalled();
  });
});
