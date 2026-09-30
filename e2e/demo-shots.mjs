// Takes screenshots of a populated board with two users, for a visual check.
// Needs `npm run dev:worker` and `npm run dev:web` running. Usage: node e2e/demo-shots.mjs <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'demo-shots';
mkdirSync(out, { recursive: true });
const board = `demo-${process.pid}`;
const url = `http://localhost:5173/?board=${board}`;

const APPS = {
  2: ['Color clock', `<style>body{margin:0;display:grid;place-items:center;height:100vh;font:700 96px system-ui;color:#fff;transition:background .6s}</style><div id=t>0</div><script>let n=0;setInterval(()=>{n++;t.textContent=n;document.body.style.background='hsl('+(n*47%360)+' 65% 45%)'},600)</script>`],
  3: ['Bouncing balls', `<style>body{margin:0;background:#0f172a}</style><canvas id=c></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;const b=[...Array(14)].map((_,i)=>({x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-.5)*14,vy:(Math.random()-.5)*14,r:18+Math.random()*30,h:i*26}));(function f(){x.fillStyle='rgba(15,23,42,.35)';x.fillRect(0,0,c.width,c.height);for(const o of b){o.x+=o.vx;o.y+=o.vy;if(o.x<o.r||o.x>c.width-o.r)o.vx*=-1;if(o.y<o.r||o.y>c.height-o.r)o.vy*=-1;x.beginPath();x.arc(o.x,o.y,o.r,0,7);x.fillStyle='hsl('+o.h+' 80% 60%)';x.fill()}requestAnimationFrame(f)})()</script>`],
  12: ['Class poll', `<style>body{margin:0;font:600 40px system-ui;background:#fef3c7;color:#78350f;padding:60px}button{font:inherit;padding:18px 34px;margin:12px;border:0;border-radius:18px;background:#f59e0b;color:#fff}</style><h1 style="margin-top:0">Best study snack?</h1><button>Apples 12</button><button>Pretzels 9</button><button>Popcorn 17</button>`],
  13: ['Solar house sketch', `<style>body{margin:0;background:linear-gradient(#bae6fd,#e0f2fe);height:100vh}</style><svg viewBox="0 0 400 250" width="100%" height="100%"><circle cx="330" cy="55" r="32" fill="#fbbf24"/><rect x="90" y="120" width="170" height="100" fill="#f8fafc" stroke="#334155" stroke-width="3"/><polygon points="80,122 175,55 270,122" fill="#64748b"/><rect x="120" y="68" width="90" height="36" fill="#1e3a8a" transform="rotate(-35 165 86)"/><rect x="150" y="160" width="36" height="60" fill="#92400e"/><rect x="205" y="145" width="36" height="30" fill="#7dd3fc" stroke="#334155" stroke-width="2"/><rect x="0" y="220" width="400" height="30" fill="#65a30d"/></svg>`],
};

async function user(browser, name, color, cursor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([p]) => localStorage.setItem('classBoard.profile', p), [JSON.stringify({ name, color, cursor })]);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__classBoard?.state.ready());
  return page;
}

async function postHtml(page, slot, title, body) {
  await page.evaluate(async ([slot, html]) => {
    const cb = window.__classBoard;
    cb.camera.fitSlot(slot);
    document.querySelector(`.tile[data-slot="${slot}"] [data-action="add"]`).click();
    const dlg = document.querySelector('.modal[data-dialog="post"]');
    dlg.querySelector('[data-tab="html"]').click();
    const ta = dlg.querySelector('textarea[name="html"]');
    ta.value = html;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    dlg.querySelector('[data-action="submit"]').click();
  }, [slot, `<!doctype html><title>${title}</title>${body}`]);
  await page.waitForFunction((s) => window.__classBoard.state.tile(s).kind === 'html', slot);
}

async function postLink(page, slot, link) {
  await page.evaluate(async ([slot, link]) => {
    window.__classBoard.camera.fitSlot(slot);
    document.querySelector(`.tile[data-slot="${slot}"] [data-action="add"]`).click();
    const dlg = document.querySelector('.modal[data-dialog="post"]');
    const input = dlg.querySelector('input[name="url"]');
    input.value = link;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dlg.querySelector('[data-action="submit"]').click();
  }, [slot, link]);
  await page.waitForFunction((s) => window.__classBoard.state.tile(s).kind === 'link', slot);
}

const browser = await chromium.launch();
const ana = await user(browser, 'Ana', '#D85A30', { kind: 'shape', shape: 'arrow' });
const ben = await user(browser, 'Ben', '#378ADD', { kind: 'shape', shape: 'star' });

for (const [slot, [title, body]] of Object.entries(APPS)) await postHtml(ana, Number(slot), title, body);
await postLink(ben, 22, 'https://example.com');
await postLink(ben, 23, 'https://github.com');
await ana.waitForTimeout(1500);

// 1. Ana zoomed to the populated corner, with Ben's cursor moving over it.
// Centered between B3 and B4 at about 95% zoom, so A3–C4 are in view.
const frame = () => { const c = window.__classBoard.camera; c.fitSlot(12); c.zoomAt(720, 426, 0.34); c.centerOn(1560, 560); };
await ana.evaluate(frame);
await ben.evaluate(frame);
await ben.mouse.move(900, 380);
await ben.mouse.move(1010, 470, { steps: 15 });
await ana.waitForTimeout(2500);
await ana.screenshot({ path: join(out, '1-zoomed-with-cursor.png') });

// 2. The whole board.
await ana.evaluate(() => window.__classBoard.camera.fitBoard());
await ana.waitForTimeout(800);
await ana.screenshot({ path: join(out, '2-overview.png') });

// 3. Focus mode on the bouncing balls.
await ana.evaluate(() => window.__classBoard.focus.enter(3));
await ana.waitForTimeout(1500);
await ana.screenshot({ path: join(out, '3-focus-mode.png') });
await ana.evaluate(() => window.__classBoard.focus.exit());

// 4. The cursor panel, drawing tab.
await ben.click('#topbar [data-action="profile"]');
await ben.click('.modal[data-dialog="profile"] [data-tab="pixels"]');
for (const cell of [34, 35, 36, 50, 53, 66, 69, 83, 84, 85, 101, 117, 116, 118]) {
  await ben.click(`.pixel-grid [data-cell="${cell}"]`);
}
await ben.waitForTimeout(400);
await ben.screenshot({ path: join(out, '4-draw-your-cursor.png') });

await browser.close();
console.log(`screenshots in ${out}`);
