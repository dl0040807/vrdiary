// VR Diary (design: "VR 다이어리 Flows"): diary + calendar on the real desk, a 3-step record, 2.5D memories.
// Everything lives under `stage` (origin = desk surface in front of the player, +Z toward the player).
import {
  BackSide,
  CanvasTexture,
  CircleGeometry,
  Box3,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Object3D,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  XRPlane,
  createSystem,
  type World,
} from '@iwsdk/core';
import { ac, sfx } from './audio.js';
import { duck, look, musicOff, musicOn, tune, type Tune } from './music.js';
import { addDays, allEntries, clearAll, dayKey, patchEntry, type Entry } from './db.js';
import { Panel } from './panel.js';
import { makePhoto3D } from './photo3d.js';
import { SAMPLES, drawSample } from './samples.js';

export const MOODS = [
  { name: 'Joy', color: '#ffd60a' },
  { name: 'Excited', color: '#ff375f' },
  { name: 'Calm', color: '#66d4cf' },
  { name: 'Sad', color: '#0a84ff' },
  { name: 'Tired', color: '#bf5af2' },
];
const STICKERS = ['⭐', '❤️', '☕', '⚽', '🎵', '🌈'];
const STICK_MAX = 8;
const PAPERS = ['#ffd60a', '#ff8fa3', '#66d4cf', '#5ac8f5']; // post-it colors
const NOTE_MAX = 4;
const NOTE_SPOTS = [[0.42, 0.18, 0.09], [-0.3, -0.42, -0.07], [0.4, -0.36, 0.05], [-0.42, 0.22, -0.1]]; // where new post-its land on the page: x, y (page fractions), tilt
const HAND = '"Nanum Pen Script", cursive';
const VOICE_MAX = 60; // seconds per voice memo
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const SUGGEST = ['Good day.', 'Great food.', 'Saw friends.', 'Rested well.'];
const KEYS = ['qwertyuiop', 'asdfghjkl\'', 'zxcvbnm,.!'];
const MEMO_MAX = 60;
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DIM = '#ffffffb3';

// ---- layout (stage-local metres) ----
const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const DIARY = V(-0.215, 0.2, -0.07), CAL = V(0.075, 0.2, -0.1);
const ORBS_Y = 0.32, MOODP = V(0, 0.19, -0.09);
const MEMOP = V(0, 0.29, -0.1), KEYB = V(0, 0.115, -0.01);
const CARDP = V(-0.135, 0.225, -0.06), TODAYP = V(0.1, 0.22, -0.08);
const PAPER = V(-0.06, 0.004, 0.02), NOTEP = V(0.2, 0.13, -0.05); // the post-it lies flat on the desk, so the real desk is what the fingertip touches
const FRAME = V(0, 0.3, -0.09), MEMCARD = V(0, 0.125, -0.04);
const orbHome = (i: number, out: Vector3) => out.set((i - 2) * 0.065, ORBS_Y, -0.09);
const stickerHome = (i: number, out: Vector3) => out.set(TODAYP.x + (i - 2.5) * 0.036, 0.345, TODAYP.z); // a row above the page
const FRAME_W = 0.3, INSIDE = 3.5;
const CAL_MIN = 0.7, CAL_MAX = 1.8; // calendar resize range
const WALL_R = 0.5, WALL_STEP = 0.26, WALL_ROWS = [0.27, 0.38, 0.49]; // month recap: photo wall around the player (radius, rad per card, row heights)

// ---- tuning (adjust on the headset) ----
const PINCH_ON = 0.02, PINCH_OFF = 0.045; // thumb-index gap
const ORB_R = 0.05; // pinch this close to an orb to take it
const SWIPE = 0.08, SWIPE_V = 0.45; // metres of fast vertical travel in front of the calendar = one month
const PUSH_V = 0.6; // m/s palm push toward the photo closes it
const TEAR_D = 0.04; // pinch a date and pull it this far to tear it off the calendar
const POKE_IN = 0.008, POKE_OUT = 0.025; // keyboard: fingertip within / back out of the key plane
const WRITE_IN = 0.006, WRITE_OUT = 0.014; // handwriting: fingertip touching / lifted off the paper
const INK_SMOOTH = 0.6; // 0..1, lower = smoother, laggier strokes

type Img = OffscreenCanvas;
type Day = { e: Entry; photo?: Img; depth?: Img; notes?: Img[] };
type Mode = 'desk' | 'record' | 'memory' | 'recap';
type Hand = {
  joints: Record<string, Object3D>; ok: boolean;
  idx: Vector3; thumb: Vector3; palm: Vector3; pinch: Vector3; prevPalm: Vector3; vel: Vector3; normal: Vector3;
  pinching: boolean; orb: number; sticker: number; note: number; writing: boolean; mic: boolean; cell: string | null; cellFrom: Vector3; tearing: boolean; card: boolean; onFrame: boolean; onCal: boolean; pokeArmed: boolean; swipe: number; inCal: boolean;
};

const toCanvas = (b: ImageBitmap) => { const c = new OffscreenCanvas(b.width, b.height); c.getContext('2d')!.drawImage(b, 0, 0); return c; };
async function fileImg(url: string) {
  const r = await fetch(url);
  if (!r.ok || !r.headers.get('content-type')?.startsWith('image')) throw new Error(url);
  return toCanvas(await createImageBitmap(await r.blob()));
}
const sampleImgs = new Map<number, Promise<{ photo: Img; depth: Img }>>();
function sampleImages(i: number) { // a real photo in public/samples if there is one, else the drawn scene
  if (!sampleImgs.has(i)) {
    const n = String(i + 1).padStart(2, '0'), base = `${import.meta.env.BASE_URL}samples/${n}`;
    sampleImgs.set(i, Promise.all([fileImg(`${base}.jpg`), fileImg(`${base}-depth.png`)])
      .then(([photo, depth]) => ({ photo, depth }))
      .catch(() => drawSample(SAMPLES[i])));
  }
  return sampleImgs.get(i)!;
}
/** A whole world for a photo (equirectangular): its sky, horizon and ground colours all around,
 *  and the photo itself, blurred and widened, in front (u = 0.25 once the map is unmirrored). */
function paintWorld(photo: Img) {
  const W = 2048, H = 1024, c = new OffscreenCanvas(W, H), g = c.getContext('2d')!;
  const s = new OffscreenCanvas(8, 8), sg = s.getContext('2d', { willReadFrequently: true })!;
  const band = (y0: number, h: number) => { // average colour of a horizontal band of the photo
    sg.drawImage(photo, 0, photo.height * y0, photo.width, photo.height * h, 0, 0, 8, 8);
    const d = sg.getImageData(0, 0, 8, 8).data, a = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { a[0] += d[i]; a[1] += d[i + 1]; a[2] += d[i + 2]; }
    return `rgb(${a.map((v) => Math.round(v / 64)).join(',')})`;
  };
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, band(0, 0.12)); sky.addColorStop(0.42, band(0.3, 0.15)); sky.addColorStop(0.5, band(0.45, 0.1));
  sky.addColorStop(0.6, band(0.65, 0.15)); sky.addColorStop(1, band(0.88, 0.12));
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const pw = W * 0.5, ph = H * 0.7, t = new OffscreenCanvas(pw, ph), tg = t.getContext('2d')!;
  tg.filter = 'blur(22px)';
  tg.drawImage(photo, -40, -40, pw + 80, ph + 80);
  tg.filter = 'none';
  tg.globalCompositeOperation = 'destination-in'; // soft edges into the colours around it
  for (const [x1, y1] of [[pw, 0], [0, ph]] as const) {
    const m = tg.createLinearGradient(0, 0, x1, y1);
    m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(0.25, '#000'); m.addColorStop(0.75, '#000'); m.addColorStop(1, 'rgba(0,0,0,0)');
    tg.fillStyle = m; tg.fillRect(0, 0, pw, ph);
  }
  g.drawImage(t, W * 0.25 - pw / 2, H * 0.5 - ph / 2);
  return c;
}

const mmdd = (k: string) => { const [, m, d] = k.split('-'); return `${MONTHS[+m - 1].slice(0, 3)} ${+d}`; };
const weekday = (k: string) => { const [y, m, d] = k.split('-'); return WEEK[new Date(+y, +m - 1, +d).getDay()]; };

export class DiarySystem extends createSystem({ planes: { required: [XRPlane] } }) {
  private stage = new Group();
  private pedestal = new Mesh(new CylinderGeometry(0.42, 0.42, 0.02, 40), new MeshPhongMaterial({ color: 0xe9dcc6 }));
  private diary = new Panel(0.16, 0.19);
  private cal = new Panel(0.3, 0.27);
  private guide = new Panel(0.75, 0.04);
  private moodP = new Panel(0.28, 0.17);
  private memoP = new Panel(0.36, 0.175);
  private keyb = new Panel(0.36, 0.14, 2200);
  private card = new Panel(0.16, 0.15); // today's photo, to drop on the page
  private todayP = new Panel(0.22, 0.175);
  private mem = new Panel(0.3, 0.1);
  private recapP = new Panel(0.3, 0.1); // month recap summary + Back
  private wall: Panel[] = []; // month recap photo cards, made on demand
  private recapT = 0;
  private fromRecap = false;
  private arrowL = new Panel(0.04, 0.04);
  private arrowR = new Panel(0.04, 0.04);
  private chip = new Panel(0.36, 0.06); // sound chip on the big photo (frame-local, width 1 = photo width)
  private orbs: Mesh[] = [];
  private stickers: Mesh[] = [];
  private cellP = new Panel(0.13, 0.075); // A: the card beside a pinched date
  private cellKey = '';
  private cellRects = new Map<string, [number, number, number, number]>(); // date -> its box on the calendar canvas
  private tearP = new Panel(0.09, 0.09); // C: the date torn off the calendar, in the hand
  private chooseP = new Panel(0.36, 0.19); // memo: type it or write by hand
  private paper = new Panel(0.2, 0.2, 2000); // the post-it you write on
  private noteP = new Panel(0.17, 0.2);
  private cursor = new Mesh(new CircleGeometry(0.004, 20), new MeshBasicMaterial({ color: 0xffffff }));
  private memoWay: 'choose' | 'type' | 'hand' | 'voice' = 'choose';
  private voiceP = new Panel(0.36, 0.175);
  private voiceChip = new Panel(0.5, 0.14, 900); // play button beside an open memory (frame units)
  private recorder: MediaRecorder | null = null;
  private recStart = 0;
  private recDrawn = 0;
  private voiceErr = '';
  private take: { blob: Blob; sec: number } | null = null; // the last recording, not yet on the page
  private voicePlayer: HTMLAudioElement | null = null;
  private paperC = 0;
  private strokes: number[][] = []; // canvas px, x,y pairs
  private notes: Panel[] = []; // post-its on today's page
  private memNotes: Panel[] = [];
  private tune: Tune | null = null; // the music made from the open photo // post-its beside an open memory
  private frame = new Group();
  private photo: Mesh | null = null;
  private around = new Mesh(new SphereGeometry(4, 48, 24), new MeshBasicMaterial({ transparent: true, opacity: 0, side: BackSide, depthWrite: false })); // the photo's world around you when inside
  private aroundT = 0;
  private desk = false; // a real desk was found (else the floating pedestal shows)
  private dim = new Mesh(new SphereGeometry(3, 24, 16), new MeshBasicMaterial({ color: 0, transparent: true, opacity: 0, side: BackSide, depthWrite: false }));
  private hands: Hand[] = [];
  private days = new Map<string, Day>();
  private own = new Set<string>(); // days you finished yourself
  private today = dayKey(new Date());
  private editDay = this.today; // the day the record screens write to
  private mode: Mode = 'desk';
  private rec = 0; // record step: 0 mood, 1 memo, 2 photo
  private placedPhoto = false;
  private month = 0; // months from the current one
  private openDay: string | null = null;
  private openT = 0; // 0 closed .. 1 open
  private scale = 1;
  private target = 1; // scale the photo eases to
  private grab: { d0: number; s0: number; cal: boolean } | null = null;
  private calScale = 1;
  private typed: string[] = [];
  private first = !localStorage.getItem('vrdiary.visited');
  private step = 0; // first visit: 0 open a date, 1 swipe, 2 record today
  private stepAt = 0;
  private memory: { date: string; label: string } | null = null; // last week / a year ago today
  private placed = false;
  private enterAt = -1;
  private t = 0;
  private swipeAt = 0;
  private blink = false;
  private listening = false;
  private guideInside = false;
  private box = new Box3();
  private v = new Vector3();
  private v2 = new Vector3();
  private q = new Quaternion();

  init() {
    const w = this.world as World;
    w.scene.add(new HemisphereLight(0xffffff, 0x9a8a7a, 1.6)); // passthrough has no lights of its own
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.4, 1, 0.6);
    w.scene.add(sun);

    this.stage.position.set(0, 1.0, -0.45);
    w.createTransformEntity(this.stage);
    this.pedestal.position.set(0, -0.011, -0.02);
    this.pedestal.visible = false;
    const put = (o: Object3D, p: Vector3, rx = 0, ry = 0) => { o.position.copy(p); o.rotation.set(rx, ry, 0); this.stage.add(o); return o; };
    put(this.pedestal, this.pedestal.position);
    put(this.diary.mesh, DIARY, -0.12, 0.3);
    put(this.cal.mesh, CAL, -0.12);
    this.stage.add(this.guide.mesh);
    put(this.moodP.mesh, MOODP, -0.15);
    put(this.memoP.mesh, MEMOP, -0.15);
    put(this.keyb.mesh, KEYB, -0.6);
    put(this.chooseP.mesh, MEMOP, -0.15);
    this.cellP.mesh.visible = this.tearP.mesh.visible = false;
    this.cal.mesh.add(this.cellP.mesh);
    put(this.tearP.mesh, CAL, -0.5);
    put(this.voiceP.mesh, MEMOP, -0.15);
    put(this.paper.mesh, PAPER, -Math.PI / 2).rotation.z = 0.035;
    put(this.noteP.mesh, NOTEP, -0.15, -0.3);
    this.cursor.position.z = 0.002;
    this.paper.mesh.add(this.cursor);
    put(this.card.mesh, CARDP, -0.12, 0.15).rotation.z = 0.06;
    put(this.todayP.mesh, TODAYP, -0.12, -0.12);
    put(this.mem.mesh, MEMCARD, -0.3);
    put(this.recapP.mesh, MEMCARD, -0.3);
    put(this.arrowL.mesh, V(-0.21, FRAME.y, FRAME.z));
    put(this.arrowR.mesh, V(0.21, FRAME.y, FRAME.z));
    for (const [p, s] of [[this.arrowL, '←'], [this.arrowR, '→']] as const) { p.begin(); p.button(s === '←' ? 'prev' : 'next', 0, 0, p.W, p.H); p.text(s, p.W / 2, p.H / 2, 72, '#fff', 'center', 'bold'); p.done(); }
    put(this.frame, FRAME);
    this.chip.mesh.position.set(0.3, 0.33, 0.02);
    this.frame.add(this.chip.mesh);
    this.voiceChip.mesh.position.set(-0.78, -0.2, 0.06);
    this.frame.add(this.voiceChip.mesh);
    for (let i = 0; i < NOTE_MAX; i++) {
      const n = new Panel(0.075, 0.075, 1600);
      n.mesh.position.z = 0.004 + i * 0.001;
      this.todayP.mesh.add(n.mesh);
      this.notes.push(n);
      const m = new Panel(0.28, 0.28, 900); // frame units: the photo is 1 wide
      m.mesh.position.set(0.66, 0.05 - i * 0.34, 0.06);
      m.mesh.rotation.z = i % 2 ? -0.08 : 0.1;
      this.frame.add(m.mesh);
      this.memNotes.push(m);
    }
    void document.fonts?.load(`40px ${HAND}`).then(() => this.drawAll());
    this.dim.renderOrder = -1;
    this.stage.add(this.dim);
    this.around.renderOrder = -2;
    this.around.visible = false;
    this.stage.add(this.around);
    MOODS.forEach((m, i) => {
      const orb = new Mesh(new SphereGeometry(0.022, 32, 20), new MeshPhongMaterial({ color: m.color, emissive: m.color, emissiveIntensity: 0.25, shininess: 80 }));
      const label = new Panel(0.05, 0.016);
      label.begin();
      label.text(m.name, label.W / 2, label.H / 2, 28, '#fff', 'center', 'bold');
      label.done();
      label.mesh.position.set(0, -0.035, 0);
      orb.add(label.mesh);
      put(orb, orbHome(i, this.v));
      this.orbs.push(orb);
    });
    STICKERS.forEach((s, i) => {
      const p = new Panel(0.03, 0.03);
      p.begin();
      p.dot(p.W / 2, p.H / 2, p.W / 2 - 2, 'rgba(255,255,255,0.22)');
      p.text(s, p.W / 2, p.H / 2 + 4, 48, '#fff', 'center');
      p.done();
      put(p.mesh, stickerHome(i, this.v), -0.12, -0.12);
      this.stickers.push(p.mesh);
    });

    for (let i = 0; i < 2; i++) {
      const hand = w.renderer.xr.getHand(i) as unknown as Object3D & { joints: Record<string, Object3D> };
      w.player.add(hand); // joints are local to the XR origin
      const nv = () => new Vector3();
      this.hands.push({ joints: hand.joints, ok: false, idx: nv(), thumb: nv(), palm: nv(), pinch: nv(), prevPalm: nv(), vel: nv(), normal: nv(),
        pinching: false, orb: -1, sticker: -1, note: -1, writing: false, mic: false, cell: null, cellFrom: nv(), tearing: false, card: false, onFrame: false, onCal: false, pokeArmed: true, swipe: 0, inCal: false });
    }
    window.addEventListener('diary:changed', this.reload);
    this.cleanupFuncs.push(() => window.removeEventListener('diary:changed', this.reload));
    this.setMode('desk');
    this.sizeCal(Math.min(CAL_MAX, Math.max(CAL_MIN, +(localStorage.getItem('vrdiary.calScale') ?? 1) || 1)));
    void this.start();
    if (import.meta.env.DEV) (window as any).__diary = this; // test hook
  }

  private async start() {
    const url = new URL(location.href);
    if (url.searchParams.has('reset')) { // judges: start over
      await clearAll();
      localStorage.removeItem('vrdiary.visited');
      this.first = true;
      url.searchParams.delete('reset');
      history.replaceState(null, '', url);
    }
    await this.reload();
  }

  /** Samples fill the 12 days before today; saved days (IndexedDB) win over them. */
  private reload = async () => {
    const now = new Date();
    this.days.clear();
    SAMPLES.forEach((s, i) => { const date = dayKey(addDays(now, -s.ago)); this.days.set(date, { e: { date, mood: s.mood, memo: s.memo, sample: i, done: true } }); });
    const saved = await allEntries();
    for (const e of saved) this.days.set(e.date, { e });
    this.own = new Set(saved.filter((e) => e.done).map((e) => e.date));
    await Promise.all([...this.days.values()].map((d) => this.loadImages(d)));
    const year = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    this.memory = [{ date: dayKey(addDays(now, -7)), label: 'A week ago today' }, { date: dayKey(year), label: 'A year ago today' }].find((m) => this.days.get(m.date)?.e.done) ?? null;
    this.drawAll();
  };

  private async loadImages(d: Day) {
    const e = d.e;
    if (e.photo) {
      d.photo = toCanvas(await createImageBitmap(e.photo));
      if (e.depth) d.depth = toCanvas(await createImageBitmap(e.depth));
      else { d.depth = new OffscreenCanvas(4, 4); const g = d.depth.getContext('2d')!; g.fillStyle = '#808080'; g.fillRect(0, 0, 4, 4); } // flat until depth exists
    } else if (e.sample !== undefined) Object.assign(d, await sampleImages(e.sample));
    if (e.notes) d.notes = await Promise.all(e.notes.map(async (n) => toCanvas(await createImageBitmap(n.img))));
  }

  private get todayE() { return this.days.get(this.editDay)?.e; } // the day being written (today, or a past day)
  private recorded(k: string) { return !!this.days.get(k)?.e.done; }

  update(dt: number, time: number) {
    const w = this.world as World;
    this.t = time;
    const immersive = !String(w.visibilityState).toLowerCase().startsWith('non');
    if (immersive && this.enterAt < 0) { this.enterAt = time; this.placed = false; }
    if (!immersive) this.enterAt = -1;
    if (immersive && !this.placed && time - this.enterAt > 1.5) this.place();
    this.stage.updateMatrixWorld();

    this.cursor.visible = false;
    for (const h of this.hands) this.readHand(h, dt);
    for (const h of this.hands) this.interact(h, dt);
    this.twoHands();
    this.animate(dt);
    const blink = this.mode === 'desk' && !this.recorded(this.today) && (!this.first || this.step >= 2) && Math.floor(time * 2) % 2 === 0;
    if (blink !== this.blink) { this.blink = blink; this.drawCal(); }
  }

  // ---------- placement ----------
  /** Put the stage on the real desk in front of the player, or on a floating disc at desk height when no desk is found. */
  private place() {
    const w = this.world as World;
    this.placed = true;
    const head = w.camera.getWorldPosition(this.v);
    const fwd = w.camera.getWorldDirection(this.v2);
    fwd.y = 0;
    fwd.normalize();
    const tx = head.x + fwd.x * 0.45, tz = head.z + fwd.z * 0.45;
    let best = 0.5, ax = tx, ay = head.y - 0.5, az = tz, desk = false;
    for (const e of this.queries.planes.entities) {
      if (!e.object3D) continue;
      const label = (e.getValue(XRPlane, '_plane') as { semanticLabel?: string } | undefined)?.semanticLabel ?? '';
      const b = this.box.setFromObject(e.object3D);
      const flat = b.max.y - b.min.y < 0.12 && b.max.y > 0.4 && b.max.y < 1.2;
      if (!(label === 'table' || label === 'desk' || (!label && flat))) continue;
      const cx = Math.max(b.min.x, Math.min(b.max.x, tx)), cz = Math.max(b.min.z, Math.min(b.max.z, tz));
      const d = Math.hypot(cx - tx, cz - tz);
      if (d < best) { best = d; ax = cx; az = cz; ay = b.max.y; desk = true; }
    }
    this.desk = desk;
    this.pedestal.visible = !desk;
    this.stage.position.set(ax, ay, az);
    this.stage.rotation.y = Math.atan2(head.x - ax, head.z - az);
    this.stage.updateMatrixWorld(true);
    this.stepAt = this.t;
    console.log(`[diary] placed desk=${desk}`);
  }

  // ---------- hands ----------
  private readHand(h: Hand, dt: number) {
    const j = h.joints, idx = j['index-finger-tip'], thumb = j['thumb-tip'], wrist = j['wrist'];
    const was = h.ok;
    h.ok = !!(idx && thumb && wrist && (idx as any).visible !== false);
    if (!h.ok) { this.letGo(h); if (h.writing) this.endStroke(h); h.pinching = h.onFrame = h.onCal = false; return; }
    idx.getWorldPosition(h.idx);
    thumb.getWorldPosition(h.thumb);
    h.prevPalm.copy(h.palm);
    (j['middle-finger-metacarpal'] ?? wrist).getWorldPosition(h.palm);
    h.pinch.addVectors(h.idx, h.thumb).multiplyScalar(0.5);
    if (was && dt > 0) h.vel.lerp(this.v.subVectors(h.palm, h.prevPalm).divideScalar(dt), 0.4);
    else h.vel.set(0, 0, 0);
    wrist.getWorldQuaternion(this.q);
    h.normal.set(0, -1, 0).applyQuaternion(this.q); // WebXR: -Y of a hand joint points out of the palm
  }

  private interact(h: Hand, dt: number) {
    if (!h.ok) return;
    const gap = h.idx.distanceTo(h.thumb);
    if (!h.pinching && gap < PINCH_ON) { h.pinching = true; this.pinchStart(h); }
    else if (h.pinching && gap > PINCH_OFF) { h.pinching = false; h.onFrame = h.onCal = false; this.letGo(h); }
    if (h.cell) { // C: pull a pinched date off the calendar
      if (!h.tearing && h.cell <= this.today && h.pinch.distanceTo(h.cellFrom) > TEAR_D) {
        h.tearing = true;
        this.cellP.mesh.visible = false;
        this.drawTear(h.cell);
        sfx.pick();
      }
      if (h.tearing) this.tearP.mesh.position.copy(this.stage.worldToLocal(this.v.copy(h.pinch)));
      return;
    }
    if (h.note >= 0) { // a post-it slides on today's page
      const n = this.notes[h.note].mesh, l = this.todayP.mesh.worldToLocal(this.v.copy(h.pinch));
      n.position.set(l.x, l.y, n.position.z);
      return;
    }
    const held = h.orb >= 0 ? this.orbs[h.orb] : h.sticker >= 0 ? this.stickers[h.sticker] : h.card ? this.card.mesh : null;
    if (held) { held.position.copy(this.stage.worldToLocal(this.v.copy(h.pinch))); return; }

    // keyboard: poke a key with the fingertip
    if (this.keyb.mesh.visible) {
      const f = this.keyb.front(h.idx), id = this.keyb.hit(h.idx, 0.03);
      if (h.pokeArmed && id && f < POKE_IN) { h.pokeArmed = false; this.tap(id); }
      else if (f > POKE_OUT || id === null) h.pokeArmed = true;
    }

    if (this.paper.mesh.visible && !h.pinching) this.write(h);

    // swipe up/down in front of the calendar = next/previous month
    const inCal = !h.pinching && this.mode === 'desk' && this.cal.hit(h.palm, 0.18) !== null && this.cal.front(h.palm) > 0;
    if (inCal && h.inCal) { // only a hand already in front of the calendar, not one arriving there
      if (Math.abs(h.vel.y) > SWIPE_V) h.swipe += h.vel.y * dt; else h.swipe *= 0.85;
      if (Math.abs(h.swipe) > SWIPE && this.t - this.swipeAt > 0.8) {
        this.swipeAt = this.t;
        this.turnMonth(h.swipe > 0 ? 1 : -1);
        h.swipe = 0;
      }
    } else h.swipe = 0;
    h.inCal = inCal;

    // open palm pushed toward the photo = put it back
    if (this.mode === 'memory' && this.openT > 0.9 && !h.pinching && !this.grab) {
      const fwd = this.v.set(0, 0, -1).applyQuaternion(this.stage.quaternion);
      const near = h.palm.distanceTo(this.frame.getWorldPosition(this.v2)) < 0.3 * this.scale;
      if (near && h.normal.dot(fwd) > 0.6 && h.vel.dot(fwd) > PUSH_V) this.closeDate();
    }
  }

  private pinchStart(h: Hand) {
    if (this.mode === 'record' && this.rec === 2) { // pick up a post-it on today's page
      const k = this.notes.findIndex((n, i) => n.mesh.visible && h.pinch.distanceTo(n.mesh.getWorldPosition(this.v)) < 0.045 && !this.hands.some((x) => x.note === i));
      if (k >= 0) { h.note = k; sfx.pick(); return; }
    }
    if (this.stickering()) { // take a sticker from the row, or peel one off the photo to move or drop it away
      let best = ORB_R;
      this.stickers.forEach((o, i) => { const d = h.pinch.distanceTo(o.getWorldPosition(this.v)); if (d < best && !this.hands.some((x) => x.sticker === i)) { best = d; h.sticker = i; } });
      const list = this.todayE?.stickers ?? [], c = this.todayP.at(h.pinch), b = this.photoBox();
      if (h.sticker < 0 && c) {
        const k = list.findIndex((st) => Math.hypot(b.x + st.x * b.w - c.x, b.y + st.y * b.h - c.y) < 50);
        if (k >= 0 && !this.hands.some((x) => x.sticker === list[k].s)) { h.sticker = list[k].s; void this.saveToday({ stickers: list.filter((_, j) => j !== k) }); }
      }
      if (h.sticker >= 0) { sfx.pick(); return; }
    }
    for (const p of [this.cellP, this.keyb, this.memoP, this.chooseP, this.noteP, this.voiceP, this.voiceChip, this.moodP, this.todayP, this.mem, this.recapP, ...this.wall, this.arrowL, this.arrowR, this.diary, this.cal, this.card]) {
      const id = p.hit(h.pinch);
      if (id === 'rec') { h.mic = true; void this.startRec(); return; } // pinch and hold to record
      if (p === this.cal && id && /^\d{4}-/.test(id)) { h.cell = id; h.cellFrom.copy(h.pinch); h.tearing = false; return; } // tap or tear: decided on release
      if (id) { this.tap(id); return; }
      if (id === '' && p === this.card) { h.card = true; sfx.pick(); return; } // pick up today's photo
      if (id === '' && p === this.cal) { h.onCal = true; this.cellP.mesh.visible = false; return; } // the calendar's edge or header: two of these = resize
      if (id === '') return; // on a panel, between buttons
    }
    if (this.mode === 'memory' && this.openT > 0.9 && h.pinch.distanceTo(this.frame.getWorldPosition(this.v)) < 0.25 * this.scale) { h.onFrame = true; return; }
    if (!(this.mode === 'record' && this.rec === 0)) return;
    let best = ORB_R;
    this.orbs.forEach((o, i) => { const d = h.pinch.distanceTo(o.getWorldPosition(this.v)); if (d < best && !this.hands.some((x) => x.orb === i)) { best = d; h.orb = i; } });
    if (h.orb >= 0) sfx.pick();
  }

  private twoHands() {
    const [a, b] = this.hands, both = a.pinching && b.pinching;
    const frame = both && a.onFrame && b.onFrame, cal = both && a.onCal && b.onCal;
    if (!frame && !cal) {
      if (this.grab && this.grab.cal) { sfx.drop(); localStorage.setItem('vrdiary.calScale', String(this.calScale)); }
      this.grab = null;
      return;
    }
    const d = a.pinch.distanceTo(b.pinch);
    this.grab ??= { d0: d, s0: cal ? this.calScale : this.scale, cal };
    const s = this.grab.s0 * d / this.grab.d0;
    if (cal) this.sizeCal(Math.min(CAL_MAX, Math.max(CAL_MIN, s)));
    else this.target = this.scale = Math.min(4, Math.max(1, s));
  }

  /** Grow the calendar from its bottom-left corner, so it never covers the diary card. */
  private sizeCal(s: number) {
    this.calScale = s;
    const m = this.cal.mesh;
    m.scale.setScalar(s);
    m.position.set(CAL.x + (s - 1) * this.cal.w / 2, CAL.y + (s - 1) * this.cal.h / 2, CAL.z);
    if (this.mode === 'desk') this.guide.mesh.position.x = m.position.x;
  }

  /** Let go of an orb (on the mood card = today's mood) or the photo card (on the page = placed). */
  private letGo(h: Hand) {
    if (h.cell) { // a short pinch = tap; a torn-off date put down away from the calendar = write that day
      const k = h.cell;
      h.cell = null;
      if (!h.tearing) return this.cellTap(k);
      h.tearing = false;
      this.tearP.mesh.visible = false;
      const p = this.tearP.mesh.getWorldPosition(this.v);
      if (this.cal.at(p, 0.06) === null && p.distanceTo(h.cellFrom) > 0.08) { sfx.drop(); this.startRecord(k); } else sfx.no();
      return;
    }
    if (h.mic) { h.mic = false; this.stopRec(); }
    if (h.note >= 0) { // dropped on the page = stays there; dragged off it = peeled off
      const i = h.note, p = this.notes[i].mesh.position, list = this.todayE?.notes ?? [], w = this.todayP.w, ph = this.todayP.h;
      h.note = -1;
      const off = Math.abs(p.x) > w / 2 + 0.02 || Math.abs(p.y) > ph / 2 + 0.02;
      sfx.drop();
      void this.saveToday({ notes: off ? list.filter((_, j) => j !== i) : list.map((n, j) => (j === i ? { ...n, x: p.x / w, y: p.y / ph } : n)) });
    }
    if (h.orb >= 0) {
      const i = h.orb, o = this.orbs[i];
      h.orb = -1;
      const onCard = this.moodP.hit(o.getWorldPosition(this.v), 0.08) !== null;
      orbHome(i, o.position);
      if (onCard) { sfx.drop(); void this.saveToday({ mood: i }); }
    }
    if (h.sticker >= 0) {
      const i = h.sticker, o = this.stickers[i], list = this.todayE?.stickers ?? [], b = this.photoBox();
      h.sticker = -1;
      const c = this.todayP.at(o.getWorldPosition(this.v), 0.08);
      stickerHome(i, o.position);
      if (c && c.x > b.x && c.x < b.x + b.w && c.y > b.y && c.y < b.y + b.h && list.length < STICK_MAX) {
        sfx.drop();
        void this.saveToday({ stickers: [...list, { s: i, x: (c.x - b.x) / b.w, y: (c.y - b.y) / b.h }] });
      }
    }
    if (h.card) {
      h.card = false;
      const onPage = this.todayP.hit(this.card.mesh.getWorldPosition(this.v), 0.08) !== null;
      this.card.mesh.position.copy(CARDP);
      if (onPage) { sfx.drop(); this.placedPhoto = true; this.drawAll(); }
    }
  }

  // ---------- handwriting ----------
  /** The index fingertip is the pen: touching the paper draws, lifting ends the stroke. */
  private write(h: Hand) {
    const f = this.paper.front(h.idx), c = this.paper.at(h.idx, 0.05);
    if (!c) { if (h.writing) this.endStroke(h); return; }
    this.cursor.visible = true;
    this.cursor.position.set((c.x / this.paper.W - 0.5) * this.paper.w, (0.5 - c.y / this.paper.H) * this.paper.h, 0.002);
    if (!h.writing) {
      if (f < WRITE_IN) { h.writing = true; this.strokes.push([c.x, c.y]); if (this.strokes.length === 1) { this.drawPaper(); this.drawNoteP(); } } // clear the hint, light up "Stick"
      return;
    }
    if (f > WRITE_OUT) return this.endStroke(h);
    const s = this.strokes[this.strokes.length - 1], lx = s[s.length - 2], ly = s[s.length - 1];
    const x = lx + (c.x - lx) * INK_SMOOTH, y = ly + (c.y - ly) * INK_SMOOTH;
    if (Math.hypot(x - lx, y - ly) > 2) { s.push(x, y); this.ink(lx, ly, x, y); }
  }

  private endStroke(h: Hand) {
    h.writing = false;
    const s = this.strokes[this.strokes.length - 1];
    if (s?.length === 2) this.ink(s[0], s[1], s[0], s[1]); // a tap = a dot
  }

  private ink(x0: number, y0: number, x1: number, y1: number) {
    const g = this.paper.g;
    g.strokeStyle = '#1c1c1e'; g.lineWidth = 8; g.lineCap = g.lineJoin = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    this.paper.done();
  }

  private async stick() {
    const notes = this.todayE?.notes ?? [];
    if (!this.strokes.length || notes.length >= NOTE_MAX) return sfx.no();
    this.drawPaper(false);
    const img = await new Promise<Blob>((ok) => this.paper.c.toBlob((b) => ok(b!), 'image/png'));
    const [x, y, r] = NOTE_SPOTS[notes.length];
    this.strokes = [];
    this.rec = 2;
    sfx.drop();
    await this.saveToday({ notes: [...notes, { img, x, y, r }] });
    this.setMode('record');
  }

  // ---------- voice memo ----------
  private async startRec() {
    if (this.recorder) return;
    this.stopPlay();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream), chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        this.take = { blob: new Blob(chunks, { type: rec.mimeType }), sec: Math.max(1, Math.round(this.t - this.recStart)) };
        this.drawVoice();
      };
      this.recorder = rec;
      this.recStart = this.t;
      this.voiceErr = '';
      rec.start();
      sfx.pick();
      if (!this.hands.some((h) => h.mic)) this.stopRec(); // let go before the mic opened
    } catch (e) {
      console.warn(e);
      this.voiceErr = 'Mic blocked. Allow it on the 2D screen first.';
      sfx.no();
    }
    this.drawVoice();
  }

  private stopRec() {
    const r = this.recorder;
    if (!r) return;
    this.recorder = null;
    if (r.state !== 'inactive') r.stop();
    sfx.drop();
  }

  private togglePlay(blob?: Blob) {
    if (this.voicePlayer) return this.stopPlay();
    if (!blob) return sfx.no();
    const a = (this.voicePlayer = new Audio(URL.createObjectURL(blob)));
    a.onended = () => this.stopPlay();
    void a.play();
    duck(true);
    this.drawVoice(); if (this.mode === 'memory') this.drawMem();
  }

  private stopPlay() {
    const a = this.voicePlayer;
    if (!a) return;
    this.voicePlayer = null;
    a.pause();
    duck(false);
    URL.revokeObjectURL(a.src);
    if (this.mode === 'record') this.drawVoice(); else if (this.mode === 'memory') this.drawMem();
  }

  /** What stands in for the one-line memo: the text, else the voice memo, else the post-its. */
  private memoText(e?: Entry) {
    const n = e?.notes?.length ?? 0;
    return e?.memo || (e?.voice ? `🎙  Voice memo ${clock(e.voiceSec ?? 0)}` : n ? `✍  ${n} post-it${n > 1 ? 's' : ''}` : '');
  }

  private stickering() { return this.mode === 'record' && this.rec === 2 && this.placedPhoto; }
  private photoBox() { return { x: 50, y: 124, w: this.todayP.W - 100, h: 150 }; } // the photo on today's page (canvas px)

  // ---------- actions ----------
  private tap(id: string) {
    sfx.tap();
    if (id === 'prev' || id === 'next') {
      if (this.mode === 'memory') return this.stepMemory(id === 'next' ? 1 : -1);
      return this.turnMonth(id === 'next' ? 1 : -1);
    }
    if (/^\d{4}-/.test(id)) { // a calendar cell
      return this.cellTap(id);
    }
    switch (id) {
      case 'openMemory': return this.openDate(this.memory!.date);
      case 'record': case 'writeToday': return this.startRecord(this.today);
      case 'cw': case 'ca': return this.startRecord(this.cellKey);
      case 'co': return this.openDate(this.cellKey);
      case 'inside': this.target = INSIDE; return;
      case 'back': return this.closeDate();
      case 'recap': return this.openRecap();
      case 'recapBack': this.fromRecap = false; sfx.close(); return this.setMode('desk');
      case 'moodNext': if (this.todayE?.mood !== undefined) { this.rec = 1; this.memoWay = 'choose'; this.typed = [...(this.todayE?.memo ?? '')]; this.setMode('record'); } return;
      case 'memoNext': if (this.typed.join('').trim()) { this.rec = 2; void this.saveToday({ memo: this.typed.join('').trim().slice(0, MEMO_MAX) }).then(() => this.setMode('record')); } return;
      case 'clear': this.typed = []; return this.drawMemo();
      case 'mic': return this.listen();
      case 'other': { const cur = this.todayE?.sample ?? -1; this.placedPhoto = false; void this.saveToday({ sample: (cur + 1) % SAMPLES.length }); return; }
      case 'finish': return void this.finish();
      case 'pickType': this.memoWay = 'type'; this.typed = [...(this.todayE?.memo ?? '')]; return this.setMode('record');
      case 'pickVoice': this.memoWay = 'voice'; this.take = null; this.voiceErr = ''; return this.setMode('record');
      case 'playTake': return this.togglePlay(this.take?.blob);
      case 'playVoice': return this.togglePlay(this.days.get(this.openDay ?? '')?.e.voice);
      case 'keepVoice': { const t = this.take; if (!t) return sfx.no(); this.take = null; this.rec = 2; sfx.drop(); void this.saveToday({ voice: t.blob, voiceSec: t.sec }).then(() => this.setMode('record')); return; }
      case 'pickHand': this.memoWay = 'hand'; this.strokes = []; return this.setMode('record');
      case 'undo': this.strokes.pop(); return this.drawPaper();
      case 'wipe': this.strokes = []; return this.drawPaper();
      case 'stick': return void this.stick();
      case 'more': this.rec = 1; this.memoWay = 'choose'; return this.setMode('record');
      case 'bk': this.typed.pop(); return this.drawMemo();
      case 'sp': this.typed.push(' '); return this.drawMemo();
    }
    if (/^pc\d$/.test(id)) { this.paperC = +id[2]; this.drawPaper(); return this.drawNoteP(); }
    if (id.startsWith('sg')) { this.typed = [...SUGGEST[+id.slice(2)]]; return this.drawMemo(); }
    if (id.length === 1 && this.typed.length < MEMO_MAX) { this.typed.push(this.typed.length ? id : id.toUpperCase()); this.drawMemo(); } // capital first letter
  }

  /** A: a short pinch on a date. Today (empty) starts writing; any other day shows a small card beside it. */
  private cellTap(k: string) {
    sfx.tap();
    if (k > this.today) return sfx.no();
    if (k === this.today && !this.recorded(k)) return this.startRecord(k);
    if (this.first && this.step === 0 && this.recorded(k)) return this.openDate(k); // first visit: straight into a memory
    const r = this.cellRects.get(k), c = this.cal, p = this.cellP;
    if (!r) return;
    this.cellKey = k;
    this.drawCell();
    const [x, y, w, h] = r;
    let lx = ((x + w) / c.W - 0.5) * c.w + p.w / 2 + 0.004;
    if (lx + p.w / 2 > c.w / 2 + 0.03) lx = (x / c.W - 0.5) * c.w - p.w / 2 - 0.004; // no room on the right: go left
    p.mesh.position.set(lx, (0.5 - (y + h / 2) / c.H) * c.h, 0.012);
    p.mesh.visible = true;
  }

  private turnMonth(dir: number) {
    this.cellP.mesh.visible = false;
    this.month += dir;
    sfx.page();
    if (this.first && this.step === 1) this.next(2);
    this.drawCal();
  }

  /** Write a day: today, or any past day (B: no first-visit lock; the tutorial only suggests). */
  private startRecord(date = this.today) {
    if (date > this.today) return sfx.no();
    this.editDay = date;
    this.cellP.mesh.visible = false;
    this.rec = this.todayE?.mood === undefined ? 0 : this.todayE?.memo || this.todayE?.notes?.length || this.todayE?.voice ? 2 : 1;
    this.memoWay = 'choose';
    this.typed = [...(this.todayE?.memo ?? '')];
    this.placedPhoto = !!this.todayE?.done; // a finished day keeps its photo on the page
    if (!this.todayE?.photo && this.todayE?.sample === undefined) void this.saveToday({ sample: Math.floor(Math.random() * SAMPLES.length) }); // a photo to place
    this.setMode('record');
  }

  private async finish() {
    const e = this.todayE;
    if (!(e && e.mood !== undefined && (e.memo || e.notes?.length || e.voice) && this.placedPhoto)) return sfx.no();
    this.own.add(this.editDay);
    localStorage.setItem('vrdiary.visited', '1');
    this.first = false;
    this.mode = 'desk';
    await this.saveToday({ done: true });
    sfx.done();
    this.setMode('desk');
  }

  private async saveToday(p: Partial<Entry>) {
    const e = await patchEntry(this.editDay, { ...this.todayE, ...p }); // a sample day is not stored yet: keep its mood, memo and photo
    const d: Day = { e };
    await this.loadImages(d);
    this.days.set(this.editDay, d);
    this.drawAll();
  }

  private listen() { // voice memo where the browser has speech recognition
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR || this.listening) return;
    const r = new SR();
    r.lang = 'en-US';
    r.onresult = (ev: any) => { this.typed = [...String(ev.results[0][0].transcript).slice(0, MEMO_MAX)]; this.drawMemo(); };
    r.onend = () => { this.listening = false; this.drawMemo(); };
    this.listening = true;
    r.start();
    this.drawMemo();
  }

  openDate(date: string) {
    const d = this.days.get(date);
    if (!d?.photo || !d.depth) return;
    this.disposePhoto();
    this.photo = makePhoto3D(d.photo, d.depth);
    this.frame.add(this.photo);
    const wm = this.around.material as MeshBasicMaterial; // paint the photo's world, centred on where you sit
    wm.map?.dispose();
    wm.map = new CanvasTexture(paintWorld(d.photo));
    wm.map.colorSpace = SRGBColorSpace;
    wm.map.wrapS = RepeatWrapping;
    wm.map.repeat.x = -1; // seen from inside, so unmirror
    wm.needsUpdate = true;
    this.around.position.copy(this.stage.worldToLocal((this.world as World).camera.getWorldPosition(this.v)));
    this.openDay = date;
    this.scale = this.target = 1;
    sfx.open();
    this.tune = tune(look(d.photo, d.depth), d.e.mood ?? 2);
    try { musicOn(ac(), this.tune); } catch {} // audio is optional
    this.setMode('memory');
  }

  private stepMemory(dir: number) { // ← → through the days that have a memory
    const list = [...this.days.keys()].filter((k) => this.recorded(k) && this.days.get(k)!.photo).sort();
    const i = list.indexOf(this.openDay!) + dir;
    if (i >= 0 && i < list.length) this.openDate(list[i]); else sfx.no();
  }

  closeDate() {
    if (!this.openDay) return;
    this.openDay = null;
    sfx.close();
    musicOff();
    this.stopPlay();
    if (this.first && this.step === 0) { this.step = 1; this.stepAt = this.t; }
    this.setMode(this.fromRecap ? 'recap' : 'desk');
  }

  /** The shown month's days, as a wall of photo cards in an arc around the player. */
  private recapDays() {
    const now = new Date(), m = new Date(now.getFullYear(), now.getMonth() + this.month, 1), n = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const out: string[] = [];
    for (let day = 1; day <= n; day++) { const k = dayKey(new Date(m.getFullYear(), m.getMonth(), day)); if (this.recorded(k) && this.days.get(k)?.photo) out.push(k); }
    return out;
  }

  private openRecap() {
    const keys = this.recapDays();
    if (!keys.length) return sfx.no();
    while (this.wall.length < keys.length) { const p = new Panel(0.11, 0.085); this.stage.add(p.mesh); this.wall.push(p); }
    const cols = Math.ceil(keys.length / WALL_ROWS.length);
    this.wall.forEach((p, i) => {
      p.mesh.visible = i < keys.length;
      if (i >= keys.length) return;
      const row = Math.floor(i / cols), inRow = Math.min(cols, keys.length - row * cols), a = ((i % cols) - (inRow - 1) / 2) * WALL_STEP;
      p.mesh.position.set(Math.sin(a) * WALL_R, WALL_ROWS[WALL_ROWS.length - 1 - row], 0.45 - Math.cos(a) * WALL_R); // the player sits ~0.45 m in front of the stage origin
      p.mesh.rotation.set(0, -a, 0);
      this.drawWallCard(p, keys[i]);
    });
    this.fromRecap = true;
    this.recapT = 0;
    sfx.open();
    this.setMode('recap');
  }

  private disposePhoto() {
    if (!this.photo) return;
    const wm = this.around.material as MeshBasicMaterial;
    wm.map?.dispose();
    wm.map = null;
    this.photo.removeFromParent();
    this.photo.geometry.dispose();
    const m = this.photo.material as MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
    this.photo = null;
  }

  private next(step: number) { this.step = step; this.stepAt = this.t; this.drawAll(); }

  /** Show the panels of one screen of the design. */
  private setMode(m: Mode) {
    this.mode = m;
    this.cellP.mesh.visible = false;
    const r = m === 'record';
    this.diary.mesh.visible = this.cal.mesh.visible = m === 'desk';
    this.moodP.mesh.visible = r && this.rec === 0;
    this.orbs.forEach((o) => (o.visible = r && this.rec === 0));
    const r1 = r && this.rec === 1;
    this.chooseP.mesh.visible = r1 && this.memoWay === 'choose';
    this.memoP.mesh.visible = this.keyb.mesh.visible = r1 && this.memoWay === 'type';
    this.paper.mesh.visible = this.noteP.mesh.visible = r1 && this.memoWay === 'hand';
    this.voiceP.mesh.visible = r1 && this.memoWay === 'voice';
    if (!this.voiceP.mesh.visible) this.stopRec();
    if (m !== 'memory' && !this.voiceP.mesh.visible) this.stopPlay();
    this.card.mesh.visible = this.todayP.mesh.visible = r && this.rec === 2;
    this.stickers.forEach((o) => (o.visible = this.stickering()));
    this.mem.mesh.visible = this.arrowL.mesh.visible = this.arrowR.mesh.visible = m === 'memory';
    this.recapP.mesh.visible = m === 'recap';
    if (m !== 'recap') for (const p of this.wall) p.mesh.visible = false;
    else { const n = this.recapDays().length; this.wall.forEach((p, i) => (p.mesh.visible = i < n)); }
    if (m === 'memory') this.frame.visible = true;
    this.drawAll();
  }

  // ---------- animation ----------
  private animate(dt: number) {
    const open = this.mode === 'memory';
    this.openT += ((open ? 1 : 0) - this.openT) * Math.min(1, dt * 6);
    if (!open && this.openT < 0.02 && this.frame.visible) { this.frame.visible = false; this.disposePhoto(); }
    if (!this.grab) this.scale += (this.target - this.scale) * Math.min(1, dt * 3);
    if (this.recorder) { // recording: tick the clock, stop at the limit
      if (this.t - this.recStart > VOICE_MAX) this.stopRec();
      else if (this.t - this.recDrawn > 0.25) { this.recDrawn = this.t; this.drawVoice(); }
    }
    if (this.mode === 'recap' && this.recapT < 1) { // cards fly out one after another
      this.recapT = Math.min(1, this.recapT + dt * 1.2);
      this.wall.forEach((p, i) => p.mesh.scale.setScalar(Math.min(1, Math.max(0.001, this.recapT * 3 - i * 0.06))));
    }
    const inside = open && this.scale > 1.3;
    this.mem.mesh.visible = this.arrowL.mesh.visible = this.arrowR.mesh.visible = open && !inside;
    this.chip.mesh.visible = inside;
    this.frame.scale.setScalar(FRAME_W * this.scale * (0.3 + 0.7 * this.openT));
    // bigger = higher and further back, so a life-size photo stands behind the desk instead of in it
    this.frame.position.set(FRAME.x, FRAME.y - 0.12 * (1 - this.openT) + (this.scale - 1) * 0.04, FRAME.z - (this.scale - 1) * 0.2);
    this.aroundT += ((inside ? 1 : 0) - this.aroundT) * Math.min(1, dt * 2.5);
    (this.around.material as MeshBasicMaterial).opacity = this.aroundT;
    this.around.visible = this.aroundT > 0.01;
    this.pedestal.visible = !this.desk && this.aroundT < 0.5;
    (this.dim.material as MeshBasicMaterial).opacity = 0.55 * this.openT * (1 - this.aroundT);
    this.orbs.forEach((o, i) => { if (!this.hands.some((h) => h.orb === i)) o.position.y = ORBS_Y + Math.sin(this.t * 2 + i) * 0.004; });
    if (this.first && this.step === 1 && this.t - this.stepAt > 20) this.next(2); // nobody gets stuck on the swipe
    if (this.guideInside !== inside) { this.guideInside = inside; this.drawGuide(); }
  }

  // ---------- drawing ----------
  private drawAll() {
    this.drawDiary(); this.drawCal(); this.drawGuide();
    if (this.mode === 'record') this.drawRecord();
    if (this.mode === 'memory') this.drawMem();
    if (this.mode === 'recap') this.drawRecap();
  }
  private drawRecord() {
    if (this.rec === 0) this.drawMood();
    else if (this.rec === 2) this.drawToday();
    else if (this.memoWay === 'choose') this.drawChoose();
    else if (this.memoWay === 'type') this.drawMemo();
    else if (this.memoWay === 'voice') this.drawVoice();
    else { this.drawPaper(); this.drawNoteP(); }
  }

  /** Pills under the current screen: [bold, light] pairs. */
  private drawGuide() {
    const items: [string, string?][] = [];
    let y = 0.04, z = -0.05;
    if (this.mode === 'desk') {
      if (this.recorded(this.today)) items.push(['✓  Come back tomorrow', 'Pinch the edges with both hands to resize']);
      else if (this.first && this.step === 0) items.push(['Pinch a date to open it']);
      else if (this.first && this.step === 1) items.push(['Swipe up or down to change months', 'Pinch a date to open a memory']);
      else items.push(["Pinch today's square to start", 'or pull any day onto the desk']);
    } else if (this.mode === 'record') {
      y = 0.085;
      if (this.rec === 0) items.push(['Pinch an orb and drop it on the card']);
      if (this.rec === 1 && this.memoWay === 'choose') items.push(['Pinch a card to choose']);
      if (this.rec === 1 && this.memoWay === 'voice') items.push(['Pinch and hold the mic while you talk', 'Let go to stop']);
      if (this.rec === 1 && this.memoWay === 'hand') items.push(['Write on the paper with your index finger', 'Lift to end a stroke']);
      if (this.rec === 2) items.push(this.placedPhoto ? ['Drop stickers on the photo', 'Optional · pull one off to remove it']
        : this.todayE?.notes?.length ? ['Pinch a post-it to move it', 'Drag it off the page to peel it off'] : ['Done in 30 seconds', 'Today fills with your photo and mood']);
    } else if (this.guideInside) {
      const e = this.days.get(this.openDay ?? '')?.e;
      y = 0.06; z = 0.02;
      items.push([`${mmdd(this.openDay ?? '')} · ${e?.memo ?? ''}`], ['Push with an open palm to close']);
    } else if (this.mode === 'recap') { y = 0.035; z = 0; items.push(['Pinch a photo to open it', 'Look around: the whole month is here']); }
    else { y = 0.035; z = 0; items.push(['Pinch the frame with both hands and spread', 'Move your head to look around']); }
    if (this.mode === 'record' && this.rec === 1 && this.memoWay === 'hand') { y = 0.03; z = -0.11; } // just behind the paper, clear of the Post-it panel
    this.guide.mesh.position.set(this.mode === 'desk' ? this.cal.mesh.position.x : this.paper.mesh.visible ? PAPER.x - 0.03 : 0, y, z);
    this.guide.mesh.rotation.x = -0.35;
    const p = this.guide, g = p.begin(), H = p.H, gap = 24;
    const width = ([b, l]: [string, string?]) => { g.font = 'bold 34px sans-serif'; let w = g.measureText(b).width; if (l) { g.font = '30px sans-serif'; w += 22 + g.measureText(l).width; } return w + 80; };
    let x = (p.W - items.reduce((a, it) => a + width(it) + gap, -gap)) / 2;
    for (const it of items) {
      const w = width(it);
      p.box(x, 2, w, H - 4, 'rgba(58,54,52,0.92)', (H - 4) / 2);
      p.text(it[0], x + 40, H / 2, 34, '#fff', 'left', 'bold');
      if (it[1]) { g.font = 'bold 34px sans-serif'; p.text(it[1], x + 40 + g.measureText(it[0]).width + 22, H / 2, 30, '#ffffffcc'); }
      x += w + gap;
    }
    p.mesh.visible = items.length > 0;
    p.done();
  }

  private drawDiary() {
    const d = this.days.get(this.today), p = this.diary, e = d?.e;
    p.begin(); p.glass(64);
    const X = 40, W = p.W - 80;
    if (e?.done && d?.photo) { // today, filled
      p.text('Diary', X, 70, 44, '#fff', 'left', 'bold');
      p.text(`${weekday(this.today)}, ${mmdd(this.today)}`, X, 128, 30, '#fff', 'left', 'bold');
      p.image(d.photo, X, 154, W, 140, 30);
      this.drawStickers(p, e, X, 154, W, 140, 40);
      d.notes?.slice(0, 2).forEach((im, i) => this.tilted(p, im, X + W - 40 - i * 110, 286 + i * 14, 96, i ? -0.08 : 0.08));
      this.moodMemo(p, X, 308, W, e.mood, this.memoText(e));
      const s = this.streak();
      if (s) p.text(`${s}-day streak`, X, p.H - 34, 28, '#fff', 'left', 'bold');
    } else if (this.memory && !this.first) { // last week's memory, ready to open
      const m = this.memory, md = this.days.get(m.date)!;
      p.text(m.label, X, 70, 44, '#fff', 'left', 'bold');
      if (md.photo) p.image(md.photo, X, 110, W, 170, 30);
      p.dot(X + 20, 322, 20, MOODS[md.e.mood ?? 2].color);
      p.wrap(`${mmdd(m.date)} · ${md.e.memo ?? ''}`, X + 56, 322, W - 56, 28, '#fff', '', 36, 1);
      p.button('openMemory', X, 362, W, 70, 'Open', 'rgba(255,255,255,0.18)', '#fff', 30);
      const s = this.streak();
      if (s) p.text(`${s}-day streak`, X, p.H - 32, 28, '#fff', 'left', 'bold');
    } else { // nothing yet today
      p.text('Diary', X, 70, 44, '#fff', 'left', 'bold');
      p.text(`${weekday(this.today)}, ${mmdd(this.today)}`, X, 128, 30, '#fff', 'left', 'bold');
      p.box(X, 160, W, 140, 'rgba(40,42,50,0.55)', 30);
      p.wrap("Today is still empty. Pinch here to write.", X + 26, 210, W - 52, 28, '#fff', '', 40, 2);
      p.button('record', X, 160, W, 140);
      p.text(`${SAMPLES.length} sample entries included.`, X, 340, 28, '#fff');
    }
    p.done();
  }

  private moodMemo(p: Panel, x: number, y: number, w: number, mood: number | undefined, memo: string) {
    p.box(x, y, w, 96, 'rgba(40,42,50,0.55)', 26);
    if (mood !== undefined) p.dot(x + 34, y + 48, 16, MOODS[mood].color);
    p.wrap(memo, x + 64, y + 32, w - 84, 26, '#fff', '', 32, 2);
  }

  private drawCell() {
    const p = this.cellP, k = this.cellKey, d = this.days.get(k), done = this.recorded(k);
    p.begin(); p.glass(30);
    if (done && d?.e.mood !== undefined) p.dot(34, 42, 12, MOODS[d.e.mood].color);
    p.text(`${mmdd(k)} · ${done ? MOODS[d?.e.mood ?? 2].name : 'empty'}`, done ? 56 : 24, 42, 28, '#fff', 'left', 'bold');
    if (done) {
      const bw = (p.W - 60) / 2;
      p.button('co', 24, 76, bw, 52, '▶ Open', '#fff', '#111', 22);
      p.button('ca', 36 + bw, 76, bw, 52, '+ Memo', 'rgba(255,255,255,0.2)', '#fff', 22);
    } else p.button('cw', 24, 76, p.W - 48, 52, '✎ Write this day', '#fff', '#111', 22);
    p.text('or pull the day onto the desk', 24, 154, 19, '#ffffffbb');
    p.done();
  }

  /** C: the date as a small page, while it is pulled off the calendar. */
  private drawTear(k: string) {
    const p = this.tearP, d = this.days.get(k);
    p.begin(); p.glass(28);
    if (d?.photo && this.recorded(k)) { p.image(d.photo, 14, 14, p.W - 28, p.H - 28, 22); p.box(14, p.H - 90, p.W - 28, 76, 'rgba(0,0,0,0.45)', 0); }
    const [, m, day] = k.split('-');
    p.text(String(+day), 28, p.H - 54, 44, '#fff', 'left', 'bold');
    p.text(`${MONTHS[+m - 1].slice(0, 3)} · ${weekday(k).slice(0, 3)}`, 92, p.H - 50, 24, '#fff');
    if (!(d?.photo && this.recorded(k))) p.text('✎', p.W / 2, p.H / 2 - 30, 64, '#ffffffcc', 'center');
    p.done();
    this.tearP.mesh.visible = true;
  }

  private drawCal() {
    const p = this.cal, g = p.begin();
    p.glass(72);
    const now = new Date(), m = new Date(now.getFullYear(), now.getMonth() + this.month, 1);
    const n = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(), start = m.getDay();
    let count = 0;
    for (let day = 1; day <= n; day++) if (this.recorded(dayKey(new Date(m.getFullYear(), m.getMonth(), day)))) count++;
    p.text(`${MONTHS[m.getMonth()]} ${m.getFullYear()}`, 50, 76, 52, '#fff', 'left', 'bold');
    p.text(`${count} days logged`, 52, 124, 26, '#ffffffcc');
    if (count) { g.font = '26px sans-serif'; const x = 52 + g.measureText(`${count} days logged`).width + 18; p.button('recap', x, 100, 190, 48, '✦ Month recap', 'rgba(255,255,255,0.2)', '#fff', 24); }
    for (const [id, x, s] of [['prev', p.W - 176, '⌃'], ['next', p.W - 100, '⌄']] as const) {
      p.button(id, x, 50, 64, 64);
      p.dot(x + 32, 82, 32, 'rgba(255,255,255,0.16)');
      p.text(s, x + 32, id === 'prev' ? 92 : 74, 40, '#fff', 'center', 'bold');
    }
    const today = this.recorded(this.today); // B: always a way to write from the calendar
    p.button('writeToday', p.W - 246, 116, 200, 40, today ? '+ Memo today' : '✎ Write today', today ? 'rgba(255,255,255,0.2)' : '#fff', today ? '#fff' : '#111', 22);
    this.cellRects.clear();
    const x0 = 46, cw = (p.W - 92) / 7, y0 = 196, rh = (p.H - y0 - 36) / 6;
    WEEK.forEach((d, i) => p.text(d.slice(0, 3), x0 + cw * (i + 0.5), 172, 26, '#ffffffcc', 'center', 'bold'));
    for (let day = 1; day <= n; day++) {
      const k = start + day - 1, x = x0 + (k % 7) * cw + 5, y = y0 + Math.floor(k / 7) * rh + 5, w = cw - 10, h = rh - 10;
      const key = dayKey(new Date(m.getFullYear(), m.getMonth(), day)), d = this.days.get(key), done = this.recorded(key);
      p.button(key, x, y, w, h);
      this.cellRects.set(key, [x, y, w, h]);
      if (done && d?.photo) {
        p.image(d.photo, x, y, w, h, 18);
        p.box(x, y, w, h, 'rgba(0,0,0,0.18)', 18);
        this.drawStickers(p, d.e, x, y, w, h, 22);
        p.dot(x + 22, y + h - 20, 11, MOODS[d.e.mood ?? 2].color);
      } else p.box(x, y, w, h, 'rgba(255,255,255,0.16)', 18);
      p.text(String(day), x + 14, y + 26, 28, '#fff', 'left', 'bold');
      if (key === this.today || key === this.memory?.date) {
        g.lineWidth = 6;
        g.strokeStyle = key === this.today && this.blink ? '#ff9f43' : '#fff';
        g.beginPath(); g.roundRect(x, y, w, h, 18); g.stroke();
      }
    }
    p.done();
  }

  private drawMood() {
    const p = this.moodP, e = this.todayE;
    p.begin(); p.glass(72);
    p.text(this.editDay === this.today ? "Today's mood" : 'Mood', 50, 76, 52, '#fff', 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, p.W - 50, 80, 30, '#fff', 'right');
    p.box(50, 130, p.W - 100, 160, 'rgba(40,42,50,0.6)', 36);
    if (e?.mood !== undefined) {
      p.dot(130, 210, 46, MOODS[e.mood].color);
      p.text(`Placed: ${MOODS[e.mood].name}`, 200, 210, 34, '#fff', 'left', 'bold');
    } else {
      const g = p.g;
      g.setLineDash([12, 10]); g.strokeStyle = '#ffffff99'; g.lineWidth = 4;
      g.beginPath(); g.arc(130, 210, 46, 0, 7); g.stroke(); g.setLineDash([]);
      p.text('Drop an orb here', 200, 210, 34, DIM, 'left', 'bold');
    }
    p.text('Colors today on the calendar.', 50, 350, 30, '#fff');
    p.button('moodNext', p.W - 170, 318, 120, 64, 'Next', e?.mood !== undefined ? '#fff' : 'rgba(255,255,255,0.25)', '#111', 30);
    p.done();
  }

  private drawMemo() {
    const p = this.memoP, text = this.typed.join('');
    p.begin(); p.glass(72);
    p.text(this.editDay === this.today ? 'Today in one line' : 'The day in one line', 50, 74, 52, '#fff', 'left', 'bold');
    p.text(`${text.length} / ${MEMO_MAX}`, p.W - 50, 80, 32, '#fff', 'right', 'bold');
    const g = p.g;
    g.font = '32px sans-serif';
    const fw = Math.min(p.W - 220, Math.max(320, g.measureText(text || 'Write about today').width + 120));
    p.box(50, 128, fw, 70, 'rgba(40,42,50,0.6)', 22);
    p.text(text || 'Write about today', 74, 163, 32, text ? '#fff' : DIM);
    if (text) { p.button('clear', 50 + fw - 58, 143, 40, 40); p.dot(50 + fw - 38, 163, 20, 'rgba(255,255,255,0.25)'); p.text('×', 50 + fw - 38, 162, 28, '#fff', 'center', 'bold'); }
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (SR) { p.button('mic', p.W - 120, 128, 70, 70); p.dot(p.W - 85, 163, 35, this.listening ? '#ff375f' : 'rgba(255,255,255,0.22)'); p.text('🎤', p.W - 85, 165, 30, '#fff', 'center'); }
    p.text('Quick phrases', 50, 240, 30, '#fff', 'left', 'bold');
    let x = 50;
    SUGGEST.forEach((s, i) => { g.font = 'bold 26px sans-serif'; const w = g.measureText(s).width + 40; p.button(`sg${i}`, x, 268, w, 64, s, 'rgba(255,255,255,0.18)', '#fff', 26); x += w + 10; });
    p.text(`Up to ${MEMO_MAX} characters.${SR ? ' Mic where supported.' : ''}`, 50, 372, 30, '#fff');
    p.button('memoNext', p.W - 170, 340, 120, 64, 'Next', text.trim() ? '#fff' : 'rgba(255,255,255,0.25)', '#111', 30);
    p.done();
    // the big-key keyboard under it
    const k = this.keyb;
    k.begin('rgba(36,38,44,0.96)', 64);
    const kw = (k.W - 60) / 10.5;
    KEYS.forEach((row, r) => [...row].forEach((ch, i) => k.button(ch, 30 + (r * 0.25 + i) * kw + 4, 30 + r * 66, kw - 8, 58, ch, 'rgba(255,255,255,0.14)', '#fff', 30)));
    k.button('sp', 30 + kw * 2, 30 + 3 * 66, kw * 4.6, 58, 'space', 'rgba(255,255,255,0.14)', '#fff', 26);
    k.button('bk', 30 + kw * 6.8, 30 + 3 * 66, kw * 1.6, 58, '⌫', 'rgba(255,255,255,0.14)', '#fff', 30);
    k.done();
  }

  private drawToday() {
    const e = this.todayE, d = this.days.get(this.editDay);
    // the photo picked before VR (or a sample), to carry onto the page
    const c = this.card;
    c.begin();
    if (d?.photo) { c.g.shadowColor = 'rgba(0,0,0,0.45)'; c.g.shadowBlur = 30; c.box(16, 16, c.W - 32, 256, '#000', 26); c.g.shadowBlur = 0; c.image(d.photo, 16, 16, c.W - 32, 256, 26); }
    if (e?.photo) c.text('Picked before VR', c.W / 2, 316, 26, '#ffffffaa', 'center', 'bold');
    else c.button('other', c.W / 2 - 120, 290, 240, 58, 'Another ▶', 'rgba(255,255,255,0.2)', '#fff', 26);
    c.mesh.visible = this.mode === 'record' && this.rec === 2 && !this.placedPhoto;
    c.done();
    this.stickers.forEach((o) => (o.visible = this.stickering()));
    const p = this.todayP, b = this.photoBox();
    p.begin(); p.glass(72);
    p.text(mmdd(this.editDay), 50, 74, 54, '#fff', 'left', 'bold');
    p.text(weekday(this.editDay), p.W - 50, 80, 30, '#fff', 'right');
    if (this.placedPhoto && d?.photo) { p.image(d.photo, b.x, b.y, b.w, b.h, 30); this.drawStickers(p, e, b.x, b.y, b.w, b.h, 56); }
    else {
      const g = p.g;
      g.setLineDash([14, 10]); g.strokeStyle = '#ffffffaa'; g.lineWidth = 4;
      g.beginPath(); g.roundRect(50, 124, p.W - 100, 150, 30); g.stroke(); g.setLineDash([]);
      p.text('Pinch the photo and drop it here', p.W / 2, 199, 30, '#fff', 'center', 'bold');
    }
    p.box(50, 290, p.W - 100, 58, 'rgba(40,42,50,0.6)', 22);
    if (e?.mood !== undefined) p.dot(82, 319, 14, MOODS[e.mood].color);
    p.wrap(this.memoText(e), 110, 319, p.W - 180, 26, '#fff', '', 32, 1);
    p.button('more', 50, 356, 170, 58, '+ Memo', 'rgba(255,255,255,0.18)', '#fff', 26);
    p.button('finish', p.W - 210, 356, 160, 58, 'Save', this.placedPhoto ? '#fff' : 'rgba(255,255,255,0.25)', '#111', 28);
    p.done();
    const imgs = d?.notes ?? [], list = e?.notes ?? [];
    this.notes.forEach((n, i) => {
      n.mesh.visible = i < list.length;
      if (i >= list.length || !imgs[i] || this.hands.some((h) => h.note === i)) return;
      n.mesh.position.set(list[i].x * p.w, list[i].y * p.h, n.mesh.position.z);
      n.mesh.rotation.z = list[i].r;
      n.begin();
      n.g.shadowColor = 'rgba(0,0,0,0.5)'; n.g.shadowBlur = 18; n.box(12, 12, n.W - 24, n.H - 24, '#000', 6); n.g.shadowBlur = 0;
      n.image(imgs[i], 12, 12, n.W - 24, n.H - 24, 6);
      n.done();
    });
  }

  /** Memo, step 1: type it or write it by hand (design "Memo 1"). */
  private drawChoose() {
    const p = this.chooseP, g = p.g;
    p.begin(); p.glass(72);
    p.text('Leave a memo', 50, 74, 52, '#fff', 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, p.W - 50, 80, 30, '#fff', 'right');
    const cw = (p.W - 148) / 3;
    const ways = [['pickType', '⌨', 'Type it', 'Keyboard. Stays as text.'], ['pickHand', '✎', 'Write by hand', 'Your fingertip makes a post-it.'], ['pickVoice', '🎙', 'Voice memo', 'Hold the mic and talk.']] as const;
    ways.forEach(([id, icon, title, desc], i) => {
      const x = 50 + i * (cw + 24);
      p.box(x, 120, cw, 270, i === 1 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.17)', 36);
      if (i === 1) { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.roundRect(x, 120, cw, 270, 36); g.stroke(); }
      p.text(icon, x + 28, 166, 44, '#fff');
      p.text(title, x + 28, 216, 32, '#fff', 'left', 'bold');
      p.wrap(desc, x + 28, 254, cw - 56, 22, '#fff', '', 28, 2);
      p.button(id, x, 120, cw, 270);
    });
    p.box(78, 322, cw - 56, 46, 'rgba(0,0,0,0.24)', 14);
    p.text('Best ramen ever.', 94, 345, 22, '#fff');
    g.save(); g.translate(50 + cw + 24 + 28, 318); g.rotate(-0.05);
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 16; g.shadowOffsetY = 8;
    p.box(0, 0, cw - 56, 54, PAPERS[0], 6); g.shadowColor = 'transparent';
    g.font = `34px ${HAND}`; g.fillStyle = '#000'; g.textAlign = 'left'; g.fillText('Ramen again', 16, 29);
    g.restore();
    const vx = 50 + 2 * (cw + 24) + 28;
    p.box(vx, 322, cw - 56, 46, 'rgba(0,0,0,0.24)', 23);
    p.text('▶', vx + 18, 346, 22, '#fff');
    for (let k = 0; k < 9; k++) { const bh = 8 + ((k * 7) % 5) * 5; p.box(vx + 50 + k * 10, 345 - bh / 2, 5, bh, '#ffffffcc', 2); }
    p.text('0:12', vx + cw - 70, 346, 20, '#fff', 'right');
    p.text('Mix them on the same day.', 50, 425, 26, '#fff');
    p.done();
  }

  /** Voice memo: pinch and hold the mic to record, then play it back or stick it on the page. */
  private drawVoice() {
    const p = this.voiceP, rec = !!this.recorder, take = this.take;
    if (!p.mesh.visible && this.mode === 'record') return;
    p.begin(); p.glass(72);
    p.text('Voice memo', 50, 74, 52, '#fff', 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, p.W - 50, 80, 30, '#fff', 'right');
    p.dot(150, 230, 86, rec ? '#ff375f' : 'rgba(255,255,255,0.22)');
    if (rec) { const g = p.g; g.strokeStyle = '#ff375f88'; g.lineWidth = 6; g.beginPath(); g.arc(150, 230, 96 + 6 * Math.sin(this.t * 8), 0, 7); g.stroke(); }
    p.text('🎙', 150, 236, 70, '#fff', 'center');
    p.button('rec', 64, 144, 172, 172);
    const status = rec ? `Recording  ${clock(this.t - this.recStart)}` : this.voiceErr || (take ? `Recorded ${clock(take.sec)}` : 'Pinch and hold the mic');
    p.wrap(status, 280, 176, p.W - 330, 36, rec ? '#ff8fa3' : '#fff', 'bold', 44, 2);
    p.text(rec ? 'Let go to stop.' : `Talk while you hold it. Up to ${VOICE_MAX} s.`, 280, 262, 26, '#ffffffcc');
    p.button('playTake', 280, 300, 180, 64, this.voicePlayer ? '■  Stop' : '▶  Play', take ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)', take ? '#fff' : '#ffffff66', 26);
    p.button('keepVoice', p.W - 300, 300, 250, 64, 'Stick on diary', take ? '#fff' : 'rgba(255,255,255,0.25)', '#111', 26);
    p.text('Stays on this device.', 50, 392, 24, '#ffffffaa');
    p.done();
  }

  /** The post-it being written on (design "Memo 2"); `label` is left off the saved image. */
  private drawPaper(label = true) {
    const p = this.paper, g = p.begin();
    p.box(0, 0, p.W, p.H, PAPERS[this.paperC], 10);
    g.strokeStyle = '#1c1c1e'; g.lineWidth = 8; g.lineCap = g.lineJoin = 'round';
    for (const s of this.strokes) {
      g.beginPath(); g.moveTo(s[0], s[1]);
      for (let i = 2; i < s.length; i += 2) g.lineTo(s[i], s[i + 1]);
      if (s.length === 2) g.lineTo(s[0], s[1]);
      g.stroke();
    }
    if (label && !this.strokes.length) p.text('Your fingertip is the pen', 30, p.H - 30, 22, '#00000099', 'left', 'bold');
    p.done();
  }

  private drawNoteP() {
    const p = this.noteP, g = p.g;
    p.begin(); p.glass(56);
    p.text('Post-it', 40, 62, 44, '#fff', 'left', 'bold');
    p.text('Paper color', 40, 122, 28, '#fff', 'left', 'bold');
    PAPERS.forEach((c, i) => {
      const x = 40 + i * 88;
      p.box(x, 148, 70, 70, c, 16);
      if (i === this.paperC) { g.strokeStyle = '#fff'; g.lineWidth = 5; g.beginPath(); g.roundRect(x - 4, 144, 78, 78, 18); g.stroke(); }
      p.button(`pc${i}`, x, 148, 70, 70);
    });
    const bw = (p.W - 92) / 2;
    p.button('undo', 40, 250, bw, 58, 'Undo stroke', 'rgba(255,255,255,0.18)', '#fff', 22);
    p.button('wipe', 52 + bw, 250, bw, 58, 'Start over', 'rgba(255,255,255,0.18)', '#fff', 22);
    p.button('stick', 40, 330, p.W - 80, 66, 'Stick on diary', this.strokes.length ? '#fff' : 'rgba(255,255,255,0.3)', '#111', 28);
    p.wrap('Your handwriting stays as you wrote it.', 40, 436, p.W - 80, 22, '#fff', '', 28, 2);
    p.done();
  }

  /** An image drawn tilted around its centre, with a soft shadow (post-its on the diary card). */
  private tilted(p: Panel, im: Img, cx: number, cy: number, s: number, r: number) {
    const g = p.g;
    g.save(); g.translate(cx, cy); g.rotate(r);
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 14; g.shadowOffsetY = 6;
    g.drawImage(im, -s / 2, -s / 2, s, s);
    g.restore();
  }

  private drawStickers(p: Panel, e: Entry | undefined, x: number, y: number, w: number, h: number, size: number) {
    for (const st of e?.stickers ?? []) p.text(STICKERS[st.s], x + st.x * w, y + st.y * h, size, '#fff', 'center');
  }

  private drawWallCard(p: Panel, k: string) {
    const d = this.days.get(k)!;
    p.begin();
    p.image(d.photo!, 0, 0, p.W, p.H, 22);
    p.box(0, p.H - 56, p.W, 56, 'rgba(0,0,0,0.45)', 0);
    p.dot(28, p.H - 28, 11, MOODS[d.e.mood ?? 2].color);
    p.text(mmdd(k), 48, p.H - 28, 26, '#fff', 'left', 'bold');
    this.drawStickers(p, d.e, 0, 0, p.W, p.H - 56, 34);
    p.button(k, 0, 0, p.W, p.H);
    p.done();
  }

  private drawRecap() {
    const keys = this.recapDays(), p = this.recapP;
    const now = new Date(), m = new Date(now.getFullYear(), now.getMonth() + this.month, 1);
    const counts = MOODS.map((_, i) => keys.filter((k) => (this.days.get(k)!.e.mood ?? 2) === i).length);
    const top = counts.indexOf(Math.max(...counts));
    p.begin(); p.glass(72);
    p.text(`${MONTHS[m.getMonth()]} ${m.getFullYear()}`, 50, 70, 46, '#fff', 'left', 'bold');
    p.text(`${keys.length} days · mostly ${MOODS[top].name}`, 50, 122, 28, '#ffffffcc');
    let x = 50; const bw = p.W - 330; // mood mix bar
    counts.forEach((c, i) => { if (!c) return; const w = bw * c / keys.length; p.box(x, 160, w, 28, MOODS[i].color, 0); x += w; });
    p.button('recapBack', p.W - 250, 150, 200, 60, 'Back', 'rgba(255,255,255,0.18)', '#fff', 30);
    p.done();
  }

  private drawMem() {
    const k = this.openDay, d = k ? this.days.get(k) : null;
    if (!k || !d) return;
    const imgs = d.notes ?? []; // post-its float beside the photo
    this.memNotes.forEach((m, i) => { m.mesh.visible = i < imgs.length; if (i < imgs.length) { m.begin(); m.image(imgs[i], 0, 0, m.W, m.H, 8); m.done(); } });
    const p = this.mem, mood = MOODS[d.e.mood ?? 2];
    p.begin(); p.glass(72);
    p.dot(70, 74, 20, mood.color);
    p.text(`${weekday(k)}, ${mmdd(k)} · ${mood.name}`, 110, 74, 40, '#fff', 'left', 'bold');
    p.wrap(this.memoText(d.e), 52, 138, p.W - 104, 30, '#fff', '', 36, 1);
    const vc = this.voiceChip; // the day's voice memo, beside the photo
    vc.mesh.visible = !!d.e.voice;
    if (d.e.voice) {
      vc.begin();
      vc.box(0, 0, vc.W, vc.H, this.voicePlayer ? '#fff' : 'rgba(30,32,40,0.75)', vc.H / 2);
      vc.text(`${this.voicePlayer ? '■' : '▶'}  Voice memo ${clock(d.e.voiceSec ?? 0)}`, vc.W / 2, vc.H / 2, 46, this.voicePlayer ? '#111' : '#fff', 'center', 'bold');
      vc.button('playVoice', 0, 0, vc.W, vc.H);
      vc.done();
    }
    const g = p.g;
    g.font = 'bold 30px sans-serif';
    const w1 = g.measureText('Step inside').width + 56, w2 = g.measureText('Back to calendar').width + 56;
    p.button('inside', 50, 172, w1, 60, 'Step inside', '#fff', '#111', 30);
    p.button('back', 50 + w1 + 16, 172, w2, 60, 'Back to calendar', 'rgba(255,255,255,0.18)', '#fff', 30);
    p.done();
    const c = this.chip;
    c.begin();
    c.g.font = 'bold 40px sans-serif';
    const label = `♪  Photo music · ${this.tune?.label ?? mood.name}`, cw = c.g.measureText(label).width + 60;
    c.box(c.W - cw, 0, cw, c.H, 'rgba(255,255,255,0.22)', c.H / 2);
    c.text(label, c.W - cw / 2, c.H / 2, 40, '#fff', 'center', 'bold');
    c.done();
  }

  private streak() { // consecutive days you wrote yourself (samples don't count), from today or yesterday backwards
    let n = 0, d = new Date();
    if (!this.own.has(dayKey(d))) d = addDays(d, -1);
    while (this.own.has(dayKey(d))) { n++; d = addDays(d, -1); }
    return n;
  }
}
