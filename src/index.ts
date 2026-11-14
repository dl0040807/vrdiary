import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { dayKey, patchEntry } from './db.js';
import { estimateDepth, shrinkPhoto } from './depth.js';
import { DiarySystem } from './diary.js';

const $ = (id: string) => document.getElementById(id)!;
const intro = $('intro');
let world: World | null = null;

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((w) => {
  world = w;
  w.registerSystem(DiarySystem);
  w.renderer.xr.addEventListener('sessionend', () => (intro.hidden = false)); // back to the 2D screen after VR
});

const enterVR = () => { if (!world) return; intro.hidden = true; world.launchXR(); };
$('sample').addEventListener('click', enterVR);
$('enter').addEventListener('click', enterVR);

// 2D screen before XR: pick today's photo from the headset gallery; depth is computed here, once, and stored with it.
const input = $('photo') as HTMLInputElement, status = $('status'), bar = $('bar');
input.addEventListener('change', () => { if (input.files?.[0]) usePhoto(input.files[0]); });

const show = (id: string) => { for (const s of intro.querySelectorAll('section')) s.hidden = s.id !== id; };

// Photo from a phone: PeerJS WebRTC. The public PeerJS server only pairs the two devices; the photo goes phone -> headset directly (encrypted).
// ponytail: no TURN server, so very strict networks can fail to connect; same Wi-Fi works.
const PEER = 'vrdiary-';
let peer: import('peerjs').Peer | null = null;
$('fromPhone').addEventListener('click', async () => {
  show('wait');
  const { Peer } = await import('peerjs');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  peer = new Peer(PEER + code);
  $('link').textContent = `${location.host}/#${code}`;
  peer.on('error', (e) => ($('waitStatus').textContent = `Could not connect (${e.type}). Go back and try again.`));
  peer.on('connection', (conn) => {
    $('waitStatus').textContent = 'Phone connected. Waiting for the photo…';
    conn.on('data', (d) => {
      conn.send('ok');
      setTimeout(() => { peer?.destroy(); peer = null; }, 500);
      usePhoto(new Blob([d as ArrayBuffer], { type: 'image/jpeg' }));
    });
  });
});
$('cancelWait').addEventListener('click', () => { peer?.destroy(); peer = null; show('landing'); });

// Phone side: opened as <site>/#123456.
const sendCode = /^#(\d{6})$/.exec(location.hash)?.[1];
if (sendCode || location.hash === '#send') {
  show('send');
  const codeIn = $('code') as HTMLInputElement, pick = $('sendPhoto') as HTMLInputElement, st = $('sendStatus');
  codeIn.value = sendCode ?? '';
  pick.addEventListener('change', async () => {
    const file = pick.files?.[0];
    if (!file) return;
    if (!/^\d{6}$/.test(codeIn.value)) { st.textContent = 'Enter the 6-digit code from your headset first.'; return; }
    st.textContent = 'Connecting to your headset…';
    const [{ Peer }, photo] = await Promise.all([import('peerjs'), shrinkPhoto(file)]);
    const me = new Peer();
    me.on('error', (e) => (st.textContent = `Could not reach the headset (${e.type}). Check the code.`));
    me.on('open', () => {
      const conn = me.connect(PEER + codeIn.value, { reliable: true });
      conn.on('open', async () => { st.textContent = 'Sending…'; conn.send(await photo.arrayBuffer()); });
      conn.on('data', () => { st.textContent = 'Sent! Put on your headset.'; setTimeout(() => me.destroy(), 500); });
    });
  });
}

async function usePhoto(file: Blob) {
  show('depth');
  const photo = await shrinkPhoto(file);
  ($('orig') as HTMLImageElement).src = URL.createObjectURL(photo);
  await patchEntry(dayKey(new Date()), { photo, depth: undefined, sample: undefined, done: false });
  window.dispatchEvent(new Event('diary:changed'));
  try {
    const depth = await estimateDepth(photo, (s) => {
      status.textContent = s;
      const pct = /(\d+)%/.exec(s)?.[1];
      bar.style.width = pct ? `${5 + +pct * 0.6}%` : '70%';
    });
    await patchEntry(dayKey(new Date()), { depth });
    window.dispatchEvent(new Event('diary:changed'));
    ($('dimg') as HTMLImageElement).src = URL.createObjectURL(depth);
    $('dimg').hidden = false;
    $('dph').hidden = true;
    bar.style.width = '100%';
    status.textContent = 'Ready in 3D. Brighter means closer.';
  } catch (e) {
    console.error(e);
    status.textContent = 'Depth failed. Your photo was saved flat.';
  }
}
