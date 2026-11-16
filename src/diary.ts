// VR Diary (design: "VR 다이어리 Flows"): diary + calendar on the real desk, a 3-step record, 2.5D memories.
// Everything lives under `stage` (origin = desk surface in front of the player, +Z toward the player).
import {
  BackSide,
  CanvasTexture,
  BoxGeometry,
  CircleGeometry,
  Box3,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
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
import { newSwipe, swipeReset, swipeStep, type Swipe } from './swipe.js';

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
const SERIF = '"DM Serif Display", Georgia, serif'; // the paper calendar's numbers
const INK = '#2b2a27', INK2 = '#7a756b', SUN = '#c8402f', SAT = '#2e5fa8', MARKER = '#d43b2a', RULE = '#e3dccb';
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
const FLIP_END = -(2 * Math.PI - 0.56); // a flipped page ends lying on the stand at the back (2 x the calendar's lean)
const DIARY = V(-0.215, 0.099, -0.07), DIARY_TILT = -0.2, CAL = V(0.075, 0.15, -0.1), CAL_TILT = -0.28; // the calendar's bottom edge rests on the desk
const PAD = 0.012; // inner margin of the glass panels (m)
const ORBS_Y = 0.37, MOODP = V(0, 0.19, -0.09);
const MEMOP = V(0, 0.315, -0.1), KEYB = V(0, 0.115, -0.01);
const CARDP = V(-0.135, 0.225, -0.06), TODAYP = V(0.1, 0.22, -0.08);
const PAPER = V(-0.06, 0.004, 0.02), NOTEP = V(0.2, 0.13, -0.05); // the post-it lies flat on the desk, so the real desk is what the fingertip touches
const FRAME = V(0, 0.3, -0.09), MEMCARD = V(0, 0.125, -0.04);
const orbHome = (i: number, out: Vector3) => out.set((i - 2) * 0.075, ORBS_Y, -0.09);
const stickerHome = (i: number, out: Vector3) => out.set(TODAYP.x + (i - 2.5) * 0.04, 0.375, TODAYP.z); // a row above the page
const FRAME_W = 0.3, INSIDE = 5; // step inside: 5x the desk size
const CAL_MIN = 0.7, CAL_MAX = 1.8, CAL_START = 1.35; // calendar resize range, and its size until you resize it
const WALL_R = 0.5, WALL_STEP = 0.26, WALL_ROWS = [0.27, 0.38, 0.49]; // month recap: photo wall around the player (radius, rad per card, row heights)

// ---- tuning (adjust on the headset) ----
const PINCH_ON = 0.02, PINCH_OFF = 0.045; // thumb-index gap
const ORB_R = 0.05; // pinch this close to an orb to take it
const PUSH_V = 0.6; // m/s palm push toward the photo closes it
const FLIP_S = 0.7; // seconds for a page to flip
const REEL_S = 4.5, REEL_PUSH = 0.25; // month recap reel: seconds per day, and how far each photo slowly pushes in
const PEEL_START = 0.015, PEEL_RIP = 0.1; // tearing the page: metres pulled down/toward you before it lifts, and before it rips off
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
  pinching: boolean; orb: number; sticker: number; note: number; writing: boolean; mic: boolean; cell: string | null; cellFrom: Vector3; tearing: boolean; card: boolean; onFrame: boolean; onCal: boolean; pokeArmed: boolean; sw: Swipe; inCal: boolean;
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

/** Average colour of a photo, 0..1 sRGB. */
function avgColour(photo: Img) {
  const c = new OffscreenCanvas(1, 1), g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(photo, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

/** The photo's world, shown only where it has bled so far: a watercolour wash spreading out from the photo
 *  (front = u 0.75 on the sphere) with a wobbly edge and a darker rim where the "paint" pools. */
const bleedMaterial = () => new ShaderMaterial({
  uniforms: { map: { value: null }, bleed: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D map; uniform float bleed; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    void main(){
      vec2 q = vec2(abs(fract(vUv.x - 0.25) - 0.5) * 2.0, (vUv.y - 0.5) * 1.4);
      float d = length(q) + (n(vUv * vec2(48.0, 24.0)) * 0.6 + n(vUv * vec2(160.0, 80.0)) * 0.4 - 0.5) * 0.12;
      float a = 1.0 - smoothstep(bleed - 0.06, bleed, d);
      vec3 c = texture2D(map, vec2(1.0 - vUv.x, vUv.y)).rgb * (1.0 - 0.3 * smoothstep(bleed - 0.06, bleed - 0.012, d) * a);
      gl_FragColor = vec4(c, a);
      #include <colorspace_fragment>
    }`,
  transparent: true, side: BackSide, depthWrite: false,
});

const mmdd = (k: string) => { const [, m, d] = k.split('-'); return `${MONTHS[+m - 1].slice(0, 3)} ${+d}`; };
const weekday = (k: string) => { const [y, m, d] = k.split('-'); return WEEK[new Date(+y, +m - 1, +d).getDay()]; };

export class DiarySystem extends createSystem({ planes: { required: [XRPlane] } }) {
  private stage = new Group();
  private pedestal = new Mesh(new CylinderGeometry(0.42, 0.42, 0.02, 40), new MeshPhongMaterial({ color: 0xe9dcc6 }));
  private diary = new Panel(0.16, 0.19);
  private cal = new Panel(0.3, 0.29);
  private flipP = new Panel(0.3, 0.29); // a copy of the page while it flips
  private flipPivot = new Group();
  private flipSnap: OffscreenCanvas | null = null;
  private flipT = -1; // 0..1 while a page flips
  private flipDir = 1;
  private peel: Hand | null = null; // the hand tearing the page off
  private ripT = -1; // 0..1 while a torn-off page falls away
  private calFromL = new Vector3();
  private guide = new Panel(0.75, 0.04);
  private moodP = new Panel(0.3, 0.19, 2400, PAD);
  private memoP = new Panel(0.36, 0.175, 2400, PAD);
  private keyb = new Panel(0.36, 0.14, 2200, 0.008);
  private card = new Panel(0.16, 0.15); // today's photo, to drop on the page
  private todayP = new Panel(0.22, 0.19, 2400, PAD);
  private mem = new Panel(0.3, 0.1, 2400, PAD);
  private recapP = new Panel(0.3, 0.1, 2400, PAD); // month recap summary + Back
  private wall: Panel[] = []; // month recap photo cards, made on demand
  private recapT = 0;
  private fromRecap = false;
  private arrowL = new Panel(0.04, 0.04);
  private arrowR = new Panel(0.04, 0.04);
  private chip = new Panel(0.36, 0.06); // sound chip on the big photo (frame-local, width 1 = photo width)
  private orbs: Mesh[] = [];
  private stickers: Mesh[] = [];
  private cellP = new Panel(0.13, 0.075, 2400, 0.006); // A: the card beside a pinched date
  private cellKey = '';
  private cellRects = new Map<string, [number, number, number, number]>(); // date -> its box on the calendar canvas
  private tearP = new Panel(0.09, 0.09); // C: the date torn off the calendar, in the hand
  private chooseP = new Panel(0.36, 0.19, 2400, PAD); // memo: type it or write by hand
  private paper = new Panel(0.2, 0.2, 2000); // the post-it you write on
  private noteP = new Panel(0.17, 0.215, 2400, PAD);
  private cursor = new Mesh(new CircleGeometry(0.004, 20), new MeshBasicMaterial({ color: 0xffffff }));
  private memoWay: 'choose' | 'type' | 'hand' | 'voice' = 'choose';
  private voiceP = new Panel(0.36, 0.175, 2400, PAD);
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
  private reel: { keys: string[]; i: number; t: number } | null = null; // the month playing day by day
  private tune: Tune | null = null; // the music made from the open photo // post-its beside an open memory
  private frame = new Group();
  private photo: Mesh | null = null;
  private around = new Mesh(new SphereGeometry(4, 48, 24), bleedMaterial()); // the photo's world, bleeding out around you
  private bleed = 0; // how far it has spread: ~0.12 the photo's edge, 0.32 around it, 1.8 everywhere
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
    put(this.diary.mesh, DIARY, DIARY_TILT, 0.3);
    this.buildStand(this.diary, DIARY_TILT);
    put(this.cal.mesh, CAL, CAL_TILT);
    this.buildTent();
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
    void Promise.all([document.fonts?.load(`40px ${HAND}`), document.fonts?.load(`40px ${SERIF}`)]).then(() => this.drawAll());
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
        pinching: false, orb: -1, sticker: -1, note: -1, writing: false, mic: false, cell: null, cellFrom: nv(), tearing: false, card: false, onFrame: false, onCal: false, pokeArmed: true, sw: newSwipe(), inCal: false });
    }
    window.addEventListener('diary:changed', this.reload);
    this.cleanupFuncs.push(() => window.removeEventListener('diary:changed', this.reload));
    this.setMode('desk');
    this.sizeCal(Math.min(CAL_MAX, Math.max(CAL_MIN, +(localStorage.getItem('vrdiary.calScale') ?? CAL_START) || CAL_START)));
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
    if (blink !== this.blink && this.flipT < 0) { this.blink = blink; this.drawCal(); }
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
    if (h.onCal && h.pinching && this.mode === 'desk') { this.peelStep(h); return; }
    const held = h.orb >= 0 ? this.orbs[h.orb] : h.sticker >= 0 ? this.stickers[h.sticker] : h.card ? this.card.mesh : null;
    if (held) { held.position.copy(this.stage.worldToLocal(this.v.copy(h.pinch))); return; }

    // keyboard: poke a key with the fingertip
    if (this.keyb.mesh.visible) {
      const f = this.keyb.front(h.idx), id = this.keyb.hit(h.idx, 0.03);
      if (h.pokeArmed && id && f < POKE_IN) { h.pokeArmed = false; this.tap(id); }
      else if (f > POKE_OUT || id === null) h.pokeArmed = true;
    }

    if (this.paper.mesh.visible && !h.pinching) this.write(h);

    // swipe down/up in front of the calendar = next/previous month (see swipe.ts)
    const inCal = !h.pinching && this.mode === 'desk' && this.cal.hit(h.palm, 0.18) !== null && this.cal.front(h.palm) > 0;
    if (inCal && h.inCal) { // only a hand already in front of the calendar, not one arriving there
      const dir = swipeStep(h.sw, h.vel.y, Math.hypot(h.vel.x, h.vel.z), dt, this.t);
      if (dir) this.turnMonth(dir);
    } else swipeReset(h.sw);
    h.inCal = inCal;

    // open palm pushed toward the photo = put it back
    if (this.mode === 'memory' && this.openT > 0.9 && !h.pinching && !this.grab) {
      const fwd = this.v.set(0, 0, -1).applyQuaternion(this.stage.quaternion);
      const near = h.palm.distanceTo(this.frame.getWorldPosition(this.v2)) < 0.3 * this.scale;
      if (near && h.normal.dot(fwd) > 0.6 && h.vel.dot(fwd) > PUSH_V) this.closeDate();
    }
  }

  private pinchStart(h: Hand) {
    if (this.reel) { this.reel = null; this.drawGuide(); return; } // any pinch stops the month reel (the photo stays open)
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
      if (id === '' && p === this.cal) { h.onCal = true; h.cellFrom.copy(h.pinch); this.cellP.mesh.visible = false; return; } // the page's paper: one hand pulls = tear it off, two hands = resize
      if (id === '') return; // on a panel, between buttons
    }
    if (this.mode === 'memory' && this.openT > 0.9 && h.pinch.distanceTo(this.frame.getWorldPosition(this.v)) < 0.25 * this.scale) { h.onFrame = true; return; }
    if (!(this.mode === 'record' && this.rec === 0)) return;
    let best = ORB_R;
    this.orbs.forEach((o, i) => { const d = h.pinch.distanceTo(o.getWorldPosition(this.v)); if (d < best && !this.hands.some((x) => x.orb === i)) { best = d; h.orb = i; } });
    if (h.orb >= 0) sfx.pick();
  }

  /** Tear the page off: pinch the paper (top or header), pull down and toward you. It lifts off the rings showing next month, and rips once pulled far enough. */
  private peelStep(h: Hand) {
    if (this.hands.every((x) => x.onCal && x.pinching)) { if (this.peel) this.cancelPeel(); return; } // two hands = resize instead
    if (this.ripT >= 0 || this.flipT >= 0) return;
    const st = this.stage, d = st.worldToLocal(this.v.copy(h.pinch)).sub(st.worldToLocal(this.calFromL.copy(h.cellFrom)));
    const pull = Math.max(0, -d.y) + Math.max(0, d.z); // down, and toward you
    if (!this.peel) {
      if (pull < PEEL_START) return;
      this.peel = h;
      this.turnMonth(1, false); // next month underneath; the old page waits on the pivot
      sfx.pick();
    }
    if (this.peel !== h) return;
    this.flipPivot.rotation.x = -Math.min(1.1, (pull / PEEL_RIP) * 1.1); // the page's bottom lifts toward you
    if (pull >= PEEL_RIP) { // rip!
      this.peel = null;
      h.onCal = false;
      this.ripT = 0;
      sfx.tear();
    }
  }

  private cancelPeel() { // let go too early: the page settles back, still this month
    this.peel = null;
    this.flipPivot.visible = false;
    this.flipPivot.rotation.x = 0;
    this.month -= 1;
    this.drawCal();
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
    else this.target = this.scale = Math.min(INSIDE, Math.max(1, s));
  }

  /** Grow the calendar from its bottom-left corner, so it never covers the diary card. */
  /** A: spiral rings over the top edge and a cardboard stand behind, so the calendar stands on the desk like a real one. */
  private buildTent() {
    const c = this.cal, w = c.w, h = c.h;
    const metal = new MeshPhongMaterial({ color: 0x9a9a9a, shininess: 90 }), ring = new TorusGeometry(0.0075, 0.0011, 8, 20);
    for (let i = 0; i < 13; i++) {
      const r = new Mesh(ring, metal);
      r.position.set(-w / 2 + 0.025 + (i * (w - 0.05)) / 12, h / 2 - 0.004, 0);
      r.rotation.y = Math.PI / 2; // loops over the top edge
      c.mesh.add(r);
    }
    this.buildStand(c, CAL_TILT);
    // the page that flips over the rings when the month turns: printed front, plain paper back
    const fp = this.flipPivot;
    fp.position.set(0, h / 2 - 0.008, 0.002);
    this.flipP.mesh.position.y = -h / 2 + 0.008;
    const back = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: 0xf1ebdd, side: BackSide, transparent: true }));
    back.position.y = this.flipP.mesh.position.y;
    fp.add(this.flipP.mesh, back);
    fp.visible = false;
    c.mesh.add(fp);
    const pages = new Mesh(new BoxGeometry(w, 0.006, 0.008), new MeshPhongMaterial({ color: 0xece4d2 })); // the stack of months under this one
    pages.position.set(0, -h / 2 + 0.003, -0.005);
    c.mesh.add(pages);
  }

  /** A cardboard stand hinged at the top edge, swung back as far as the front leans, so both feet rest on the desk. */
  private buildStand(p: Panel, tilt: number) {
    const pivot = new Group(), stand = new Mesh(new BoxGeometry(p.w * 0.94, p.h * 0.98, 0.003), new MeshPhongMaterial({ color: 0xc9bea6, side: DoubleSide }));
    pivot.position.set(0, p.h / 2 - 0.006, -0.003);
    pivot.rotation.x = -2 * tilt;
    stand.position.y = -p.h * 0.49;
    pivot.add(stand);
    p.mesh.add(pivot);
  }

  private sizeCal(s: number) {
    this.calScale = s;
    const m = this.cal.mesh;
    m.scale.setScalar(s);
    m.position.copy(this.v.set((s - 1) * this.cal.w / 2, (s - 1) * this.cal.h / 2, 0).applyQuaternion(m.quaternion).add(CAL)); // bottom-left corner stays put, tilt and all
    if (this.mode === 'desk') this.guide.mesh.position.x = m.position.x;
  }

  /** Let go of an orb (on the mood card = today's mood) or the photo card (on the page = placed). */
  private letGo(h: Hand) {
    if (this.peel === h) this.cancelPeel();
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
      case 'reel': this.reel = { keys: this.recapDays(), i: -1, t: 0 }; return this.reelNext();
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

  /** Turn the month like a spiral desk calendar: next = this page flips up over the rings to the back; previous = a page comes back over the top. */
  private turnMonth(dir: number, animate = true) {
    this.cellP.mesh.visible = false;
    if (this.flipT >= 0) this.endFlip();
    if (this.ripT >= 0) this.endRip();
    const c = this.cal, f = this.flipP, snap = (this.flipSnap ??= new OffscreenCanvas(c.W, c.H)), sg = snap.getContext('2d')!;
    sg.clearRect(0, 0, c.W, c.H); sg.drawImage(c.c, 0, 0); // the page as it was
    this.month += dir;
    sfx.page();
    if (this.first && this.step === 1) this.next(2);
    this.drawCal(); // the new month underneath (and its buttons)
    f.g.clearRect(0, 0, f.W, f.H);
    f.g.drawImage(dir > 0 ? snap : c.c, 0, 0); // next: the old page leaves; previous: the new page arrives
    f.done();
    if (dir < 0) { c.g.clearRect(0, 0, c.W, c.H); c.g.drawImage(snap, 0, 0); c.done(); } // keep showing the old page until the new one lands on it
    this.flipDir = dir;
    this.flipT = animate ? 0 : -1; // not animated: the hand moves the page (tearing)
    this.flipPivot.rotation.x = dir > 0 ? 0 : FLIP_END;
    this.flipPivot.visible = true;
  }

  private endRip() {
    this.ripT = -1;
    const fp = this.flipPivot;
    fp.visible = false;
    fp.rotation.set(0, 0, 0);
    fp.position.set(0, this.cal.h / 2 - 0.008, 0.002);
    fp.traverse((o) => { const m = (o as Mesh).material as MeshBasicMaterial | undefined; if (m) m.opacity = 1; });
  }

  private endFlip() {
    this.flipT = -1;
    this.flipPivot.visible = false;
    if (this.flipDir < 0) this.drawCal();
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
    const map = new CanvasTexture(paintWorld(d.photo)); // the photo's world, centred on where you sit
    map.colorSpace = SRGBColorSpace;
    map.wrapS = RepeatWrapping;
    (this.around.material as ShaderMaterial).uniforms.map.value = map;
    this.bleed = 0; // every memory bleeds out afresh
    this.around.position.copy(this.stage.worldToLocal((this.world as World).camera.getWorldPosition(this.v)));
    const [r, g, b] = avgColour(d.photo); // the room takes on the photo's light
    const m = (r + g + b) / 3, tint = (c: number) => Math.max(0, m + (c - m) * 2.5) * 0.4; // its average colour, more saturated, kept dark
    (this.dim.material as MeshBasicMaterial).color.setRGB(tint(r), tint(g), tint(b), SRGBColorSpace);
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

  /** The month as a reel: each day opens in turn, pushes in slowly with its own music, then the next. */
  private reelNext() {
    const r = this.reel;
    if (!r) return;
    r.i++; r.t = 0;
    if (r.i >= r.keys.length) { this.reel = null; return this.closeDate(); } // back to the photo wall
    this.openT = 0.2; // each day grows in from small, like a cut
    this.openDate(r.keys[r.i]);
  }

  closeDate() {
    if (!this.openDay) return;
    this.reel = null;
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
    const u = (this.around.material as ShaderMaterial).uniforms.map;
    u.value?.dispose();
    u.value = null;
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
    if (this.reel && this.mode === 'memory') { // slow push-in, then the next day
      this.reel.t += dt;
      this.target = 1 + REEL_PUSH * Math.min(1, this.reel.t / REEL_S);
      if (this.reel.t > REEL_S) this.reelNext();
    }
    if (!this.grab) this.scale += (this.target - this.scale) * Math.min(1, dt * 3);
    if (this.ripT >= 0) { // the torn-off page drops toward the desk, twisting, and fades
      this.ripT = Math.min(1, this.ripT + dt / 0.8);
      const t = this.ripT, fp = this.flipPivot;
      fp.rotation.x = -1.1 - 0.9 * t;
      fp.rotation.z = 0.5 * t;
      fp.position.set(0.04 * t, this.cal.h / 2 - 0.008 - 0.22 * t * t, 0.002 + 0.12 * t);
      fp.traverse((o) => { const m = (o as Mesh).material as MeshBasicMaterial | undefined; if (m) m.opacity = 1 - t * t; });
      if (t >= 1) this.endRip();
    }
    if (this.flipT >= 0) { // the page swings forward, up over the rings and down the back (or the reverse)
      this.flipT = Math.min(1, this.flipT + dt / FLIP_S);
      const t = this.flipT, e = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
      this.flipPivot.rotation.x = (this.flipDir > 0 ? e : 1 - e) * FLIP_END;
      if (t >= 1) this.endFlip();
    }
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
    this.frame.position.set(FRAME.x, FRAME.y - 0.12 * (1 - this.openT) + (this.scale - 1) * 0.04, FRAME.z - (this.scale - 1) * 0.12); // backs off as it grows, but slower than it grows, so it looks bigger
    this.aroundT += ((inside ? 1 : 0) - this.aroundT) * Math.min(1, dt * 2.5);
    const to = !open ? 0 : inside ? 1.8 : 0.32; // opening: a slow wash around the photo; inside: everywhere
    this.bleed = to > this.bleed ? Math.min(to, this.bleed + dt * (inside ? 0.7 : 0.06)) : Math.max(to, this.bleed - dt * 2);
    (this.around.material as ShaderMaterial).uniforms.bleed.value = this.bleed;
    this.around.visible = this.bleed > 0.01 && !!this.photo;
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
    let y = 0.035, z = 0.03; // desk: just in front of the calendar's foot
    if (this.mode === 'desk') {
      if (this.recorded(this.today)) items.push(['✓  Come back tomorrow', 'Pinch the edges with both hands to resize']);
      else if (this.first && this.step === 0) items.push(['Pinch a date to open it']);
      else if (this.first && this.step === 1) items.push(['Pinch the top of the page and pull it down', 'Tears off this month · or swipe']);
      else items.push(["Pinch today's square to start", 'or pull any day onto the desk']);
    } else if (this.mode === 'record') {
      y = 0.055; // under the (now roomier) cards
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
    } else if (this.reel) { y = 0.035; z = 0; items.push([`Month recap · ${this.reel.i + 1} / ${this.reel.keys.length}`, 'Pinch anywhere to stop']); }
    else if (this.mode === 'recap') { y = 0.035; z = 0; items.push(['Pinch a photo to open it', 'or press Play to watch the month']); }
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

  /** Paper behind a card, like the calendar's: cream with a little grain. */
  private paperBg(p: Panel) {
    const g = p.g;
    p.box(0, 0, p.W, p.H, '#fbf7ee', 6);
    g.fillStyle = 'rgba(120,100,60,0.035)';
    for (let i = 0; i < 400; i++) g.fillRect(Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1) * p.W, Math.abs((Math.sin(i * 78.233) * 12345.678) % 1) * p.H, 2, 2);
  }

  /** A photo as a small white-bordered print, a little crooked. */
  private polaroid(p: Panel, im: Img, x: number, y: number, w: number, h: number, r: number) {
    const g = p.g;
    g.save(); g.translate(x + w / 2, y + h / 2); g.rotate(r);
    g.shadowColor = 'rgba(60,45,20,0.25)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
    p.box(-w / 2, -h / 2, w, h, '#fff', 3); g.shadowColor = 'transparent';
    p.image(im, -w / 2 + 10, -h / 2 + 10, w - 20, h - 34, 2);
    g.restore();
  }

  /** The diary card beside the calendar, on the same paper: washi tape, a print of the day, the line in handwriting. */
  private drawDiary() {
    const d = this.days.get(this.today), p = this.diary, e = d?.e, g = p.begin();
    this.paperBg(p);
    g.save(); g.translate(p.W / 2, 8); g.rotate(-0.05); g.fillStyle = 'rgba(102,212,207,0.6)'; g.fillRect(-64, -12, 128, 30); g.restore(); // washi tape
    const X = 34, W = p.W - 68;
    const header = (small: string, big?: string) => {
      g.font = '600 18px sans-serif'; g.letterSpacing = '4px'; g.fillStyle = INK2; g.textAlign = 'left'; g.fillText(small.toUpperCase(), X, 46); g.letterSpacing = '0px';
      if (big) p.text(big, X, 84, 38, INK, 'left', '', SERIF);
    };
    const lines = (y0: number) => { g.strokeStyle = RULE; g.lineWidth = 2; for (let y = y0; y < p.H - 30; y += 36) { g.beginPath(); g.moveTo(X, y); g.lineTo(X + W, y); g.stroke(); } };
    const hand = (s: string, y: number, mood?: number) => {
      if (mood !== undefined) p.dot(X + 10, y - 8, 9, MOODS[mood].color);
      p.wrap(s, X + (mood !== undefined ? 28 : 0), y - 8, W - 28, 32, INK, '', 36, 2, HAND);
    };
    if (e?.done && d?.photo) { // today, filled
      header(weekday(this.today), mmdd(this.today));
      this.polaroid(p, d.photo, X, 108, W, 190, -0.03);
      this.drawStickers(p, e, X + 10, 118, W - 20, 156, 34);
      d.notes?.slice(0, 2).forEach((im, i) => this.tilted(p, im, X + W - 30 - i * 96, 280 + i * 12, 84, i ? -0.08 : 0.08));
      lines(342); hand(this.memoText(e), 330, e.mood);
      const s = this.streak();
      if (s) p.text(`${s}-day streak`, X, p.H - 20, 20, INK2, 'left', 'bold');
    } else if (this.memory && !this.first) { // last week's memory, ready to open
      const m = this.memory, md = this.days.get(m.date)!;
      header(m.label);
      if (md.photo) this.polaroid(p, md.photo, X, 62, W, 200, 0.025);
      lines(306); hand(`${mmdd(m.date)} · ${md.e.memo ?? ''}`, 294, md.e.mood);
      p.button('openMemory', X, p.H - 70, W, 48, '▶ Open', MARKER, '#fff', 24);
    } else { // nothing yet today
      header(weekday(this.today), mmdd(this.today));
      g.setLineDash([10, 8]); g.strokeStyle = INK2; g.lineWidth = 3; g.beginPath(); g.roundRect(X, 108, W, 170, 6); g.stroke(); g.setLineDash([]);
      p.wrap('Today is still empty.', X + 18, 170, W - 36, 34, INK, '', 38, 1, HAND);
      p.wrap('Pinch here to write.', X + 18, 210, W - 36, 34, MARKER, '', 38, 1, HAND);
      p.button('record', X, 108, W, 170);
      lines(318);
      p.text(`${SAMPLES.length} sample entries included.`, X, p.H - 22, 20, INK2);
    }
    p.done();
  }


  private drawCell() { // a little paper note beside the date
    const p = this.cellP, k = this.cellKey, d = this.days.get(k), done = this.recorded(k), g = p.begin();
    p.box(0, 0, p.W, p.H, '#fffdf6', 10);
    g.strokeStyle = RULE; g.lineWidth = 3; g.beginPath(); g.roundRect(1.5, 1.5, p.W - 3, p.H - 3, 10); g.stroke();
    if (done && d?.e.mood !== undefined) p.dot(34, 42, 12, MOODS[d.e.mood].color);
    p.text(`${mmdd(k)} · ${done ? MOODS[d?.e.mood ?? 2].name : 'empty'}`, done ? 56 : 24, 42, 28, INK, 'left', 'bold');
    if (done) {
      const bw = (p.W - 60) / 2;
      p.button('co', 24, 76, bw, 52, '▶ Open', MARKER, '#fff', 22);
      p.button('ca', 36 + bw, 76, bw, 52, '+ Memo', 'rgba(43,42,39,0.1)', INK, 22);
    } else p.button('cw', 24, 76, p.W - 48, 52, '✎ Write this day', MARKER, '#fff', 22);
    p.text('or pull the day onto the desk', 24, 154, 19, INK2);
    p.done();
  }

  /** C: the date as a small page, while it is pulled off the calendar. */
  private drawTear(k: string) {
    const p = this.tearP, d = this.days.get(k), done = !!(d?.photo && this.recorded(k));
    p.begin(); p.paper(24);
    if (d?.photo && this.recorded(k)) { p.image(d.photo, 14, 14, p.W - 28, p.H - 28, 22); p.box(14, p.H - 90, p.W - 28, 76, 'rgba(0,0,0,0.45)', 0); }
    const [, m, day] = k.split('-');
    p.text(String(+day), 28, p.H - 54, 44, done ? '#fff' : INK, 'left', 'bold', SERIF);
    p.text(`${MONTHS[+m - 1].slice(0, 3)} · ${weekday(k).slice(0, 3)}`, 92, p.H - 50, 24, done ? '#fff' : INK2);
    if (!(d?.photo && this.recorded(k))) p.text('✎', p.W / 2, p.H / 2 - 30, 64, INK2, 'center');
    p.done();
    this.tearP.mesh.visible = true;
  }

  /** A: a paper desk calendar — cream paper, punched holes under the rings, serif numbers, red Sundays, blue Saturdays, ruled grid, today circled in red marker. */
  private drawCal() {
    const p = this.cal, g = p.begin();
    p.box(0, 0, p.W, p.H, '#fbf7ee', 6);
    g.fillStyle = 'rgba(120,100,60,0.035)'; // a little paper grain
    for (let i = 0; i < 900; i++) { const r = (Math.sin(i * 12.9898) * 43758.5453) % 1, q = (Math.sin(i * 78.233) * 12345.678) % 1; g.fillRect(Math.abs(r) * p.W, Math.abs(q) * p.H, 2, 2); }
    for (let i = 0; i < 13; i++) { // holes for the rings
      const x = 0.025 / p.w * p.W + (i * (p.W - (0.05 / p.w) * p.W)) / 12;
      g.fillStyle = '#3a372f'; g.beginPath(); g.ellipse(x, 20, 6, 9, 0, 0, 7); g.fill();
    }
    const now = new Date(), m = new Date(now.getFullYear(), now.getMonth() + this.month, 1);
    const n = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(), start = m.getDay();
    let count = 0;
    for (let day = 1; day <= n; day++) if (this.recorded(dayKey(new Date(m.getFullYear(), m.getMonth(), day)))) count++;
    g.font = `110px ${SERIF}`; g.fillStyle = SUN; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const num = String(m.getMonth() + 1);
    g.fillText(num, 40, 138);
    const nx = 40 + g.measureText(num).width + 22;
    g.textBaseline = 'middle';
    g.font = '600 26px sans-serif'; g.fillStyle = INK; g.letterSpacing = '6px';
    g.fillText(`${MONTHS[m.getMonth()].toUpperCase()} ${m.getFullYear()}`, nx, 84);
    g.letterSpacing = '0px';
    p.text(`${count} days logged`, nx, 122, 24, INK2);
    for (const [id, x, s] of [['prev', p.W - 158, '⌃'], ['next', p.W - 86, '⌄']] as const) {
      p.button(id, x, 60, 56, 56);
      g.strokeStyle = INK; g.lineWidth = 3; g.beginPath(); g.arc(x + 28, 88, 26, 0, 7); g.stroke();
      p.text(s, x + 28, id === 'prev' ? 98 : 80, 36, INK, 'center', 'bold');
    }
    const pill = (id: string, x: number, w: number, label: string, filled: boolean) => {
      p.button(id, x, 156, w, 44);
      g.lineWidth = 3; g.strokeStyle = filled ? MARKER : INK; g.fillStyle = filled ? MARKER : 'transparent';
      g.beginPath(); g.roundRect(x, 156, w, 44, 22); if (filled) g.fill(); g.stroke();
      p.text(label, x + w / 2, 178, 22, filled ? '#fff' : INK, 'center', 'bold');
    };
    const today = this.recorded(this.today); // B: always a way to write from the calendar
    pill('writeToday', 40, 200, today ? '+ Memo today' : '✎ Write today', !today);
    if (count) pill('recap', 254, 200, '✦ Month recap', false);
    this.cellRects.clear();
    const x0 = 34, cw = (p.W - 68) / 7, y0 = 262, rh = (p.H - y0 - 22) / 6;
    g.font = '600 20px sans-serif'; g.letterSpacing = '3px'; g.textAlign = 'center';
    WEEK.forEach((d, i) => { g.fillStyle = i === 0 ? SUN : i === 6 ? SAT : INK2; g.fillText(d.slice(0, 3).toUpperCase(), x0 + cw * (i + 0.5), 240); });
    g.letterSpacing = '0px';
    g.strokeStyle = RULE; g.lineWidth = 2; // ruled grid
    const rows = Math.ceil((start + n) / 7);
    for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(x0, y0 + r * rh); g.lineTo(p.W - x0, y0 + r * rh); g.stroke(); }
    for (let c = 1; c < 7; c++) { g.beginPath(); g.moveTo(x0 + c * cw, y0); g.lineTo(x0 + c * cw, y0 + rows * rh); g.stroke(); }
    for (let day = 1; day <= n; day++) {
      const k = start + day - 1, col = k % 7, x = x0 + col * cw, y = y0 + Math.floor(k / 7) * rh, w = cw, h = rh;
      const key = dayKey(new Date(m.getFullYear(), m.getMonth(), day)), d = this.days.get(key), done = this.recorded(key);
      p.button(key, x, y, w, h);
      this.cellRects.set(key, [x, y, w, h]);
      g.font = `30px ${SERIF}`; g.textAlign = 'left'; g.fillStyle = col === 0 ? SUN : col === 6 ? SAT : INK;
      g.fillText(String(day), x + 10, y + 24);
      if (done && d?.photo) { // a tiny print of the day's photo, and the mood as an ink dot
        const tw = w * 0.6, th = h * 0.48, tx = x + w - tw - 7, ty = y + h - th - 7; // lower right, clear of the date
        p.box(tx - 3, ty - 3, tw + 6, th + 6, '#fff', 3);
        p.image(d.photo, tx, ty, tw, th, 2);
        this.drawStickers(p, d.e, tx, ty, tw, th, 18);
        p.dot(x + 14, y + h - 14, 8, MOODS[d.e.mood ?? 2].color);
      }
      if (key === this.today) { // circled in red marker
        g.strokeStyle = MARKER; g.lineWidth = this.blink ? 7 : 4;
        g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2 - 3, h / 2 - 3, -0.08, 0.15, Math.PI * 2 - 0.05); g.stroke();
      } else if (key === this.memory?.date) {
        g.strokeStyle = INK2; g.lineWidth = 3; g.setLineDash([8, 7]);
        g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2 - 5, h / 2 - 5, 0.05, 0, 7); g.stroke(); g.setLineDash([]);
      }
    }
    p.done();
  }

  private drawMood() {
    const p = this.moodP, e = this.todayE;
    p.begin(); p.paper();
    p.text(this.editDay === this.today ? "Today's mood" : 'Mood', 40, 50, 52, INK, 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, 40, 106, 28, INK2);
    p.box(40, 146, p.W - 80, 160, 'rgba(43,42,39,0.06)', 36);
    if (e?.mood !== undefined) {
      p.dot(124, 226, 46, MOODS[e.mood].color);
      p.text(`Placed: ${MOODS[e.mood].name}`, 196, 226, 34, INK, 'left', 'bold');
    } else {
      const g = p.g;
      g.setLineDash([12, 10]); g.strokeStyle = INK2; g.lineWidth = 4;
      g.beginPath(); g.arc(124, 226, 46, 0, 7); g.stroke(); g.setLineDash([]);
      p.text('Drop an orb here', 196, 226, 34, INK2, 'left', 'bold');
    }
    p.text('Colors the day on the calendar.', 40, 384, 28, INK);
    p.button('moodNext', p.W - 160, 352, 120, 64, 'Next', e?.mood !== undefined ? MARKER : 'rgba(43,42,39,0.12)', e?.mood !== undefined ? '#fff' : INK2, 30);
    p.done();
  }

  private drawMemo() {
    const p = this.memoP, text = this.typed.join('');
    p.begin(); p.paper();
    p.text(this.editDay === this.today ? 'Today in one line' : 'The day in one line', 50, 74, 52, INK, 'left', 'bold');
    p.text(`${text.length} / ${MEMO_MAX}`, p.W - 50, 80, 32, INK, 'right', 'bold');
    const g = p.g;
    g.font = '32px sans-serif';
    const fw = Math.min(p.W - 220, Math.max(320, g.measureText(text || 'Write about today').width + 120));
    p.box(50, 128, fw, 70, 'rgba(43,42,39,0.06)', 22);
    p.text(text || 'Write about today', 74, 163, 32, text ? INK : INK2);
    if (text) { p.button('clear', 50 + fw - 58, 143, 40, 40); p.dot(50 + fw - 38, 163, 20, 'rgba(43,42,39,0.12)'); p.text('×', 50 + fw - 38, 162, 28, INK, 'center', 'bold'); }
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (SR) { p.button('mic', p.W - 120, 128, 70, 70); p.dot(p.W - 85, 163, 35, this.listening ? '#ff375f' : 'rgba(43,42,39,0.11)'); p.text('🎤', p.W - 85, 165, 30, INK, 'center'); }
    p.text('Quick phrases', 50, 240, 30, INK, 'left', 'bold');
    let x = 50;
    SUGGEST.forEach((s, i) => { g.font = 'bold 26px sans-serif'; const w = g.measureText(s).width + 40; p.button(`sg${i}`, x, 268, w, 64, s, 'rgba(43,42,39,0.09)', INK, 26); x += w + 10; });
    p.text(`Up to ${MEMO_MAX} characters.${SR ? ' Mic where supported.' : ''}`, 50, 372, 30, INK);
    p.button('memoNext', p.W - 170, 340, 120, 64, 'Next', text.trim() ? MARKER : 'rgba(43,42,39,0.12)', text.trim() ? '#fff' : INK2, 30);
    p.done();
    // the big-key keyboard under it
    const k = this.keyb;
    k.begin(); k.paper();
    const kw = (k.W - 60) / 10.5;
    KEYS.forEach((row, r) => [...row].forEach((ch, i) => k.button(ch, 30 + (r * 0.25 + i) * kw + 4, 30 + r * 66, kw - 8, 58, ch, 'rgba(43,42,39,0.07)', INK, 30)));
    k.button('sp', 30 + kw * 2, 30 + 3 * 66, kw * 4.6, 58, 'space', 'rgba(43,42,39,0.07)', INK, 26);
    k.button('bk', 30 + kw * 6.8, 30 + 3 * 66, kw * 1.6, 58, '⌫', 'rgba(43,42,39,0.07)', INK, 30);
    k.done();
  }

  private drawToday() {
    const e = this.todayE, d = this.days.get(this.editDay);
    // the photo picked before VR (or a sample), to carry onto the page
    const c = this.card;
    c.begin(); c.paper(24); // the picked photo, as a print
    if (d?.photo) { c.g.shadowColor = 'rgba(0,0,0,0.45)'; c.g.shadowBlur = 30; c.box(16, 16, c.W - 32, 256, '#000', 26); c.g.shadowBlur = 0; c.image(d.photo, 16, 16, c.W - 32, 256, 26); }
    if (e?.photo) c.text('Picked before VR', c.W / 2, 316, 26, INK2, 'center', 'bold');
    else c.button('other', c.W / 2 - 120, 290, 240, 58, 'Another ▶', 'rgba(43,42,39,0.10)', INK, 26);
    c.mesh.visible = this.mode === 'record' && this.rec === 2 && !this.placedPhoto;
    c.done();
    this.stickers.forEach((o) => (o.visible = this.stickering()));
    const p = this.todayP, b = this.photoBox();
    p.begin(); p.paper();
    p.text(mmdd(this.editDay), 50, 74, 54, INK, 'left', 'bold');
    p.text(weekday(this.editDay), p.W - 50, 80, 30, INK, 'right');
    if (this.placedPhoto && d?.photo) { p.image(d.photo, b.x, b.y, b.w, b.h, 30); this.drawStickers(p, e, b.x, b.y, b.w, b.h, 56); }
    else {
      const g = p.g;
      g.setLineDash([14, 10]); g.strokeStyle = INK2; g.lineWidth = 4;
      g.beginPath(); g.roundRect(50, 124, p.W - 100, 150, 30); g.stroke(); g.setLineDash([]);
      p.text('Pinch the photo and drop it here', p.W / 2, 199, 30, INK, 'center', 'bold');
    }
    p.box(50, 300, p.W - 100, 58, 'rgba(43,42,39,0.06)', 22);
    if (e?.mood !== undefined) p.dot(82, 329, 14, MOODS[e.mood].color);
    p.wrap(this.memoText(e), 110, 329, p.W - 180, 26, INK, '', 32, 1);
    p.button('more', 50, 384, 170, 58, '+ Memo', 'rgba(43,42,39,0.09)', INK, 26);
    p.button('finish', p.W - 210, 384, 160, 58, 'Save', this.placedPhoto ? MARKER : 'rgba(43,42,39,0.12)', this.placedPhoto ? '#fff' : INK2, 28);
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
    p.begin(); p.paper();
    p.text('Leave a memo', 50, 74, 52, INK, 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, p.W - 50, 80, 30, INK, 'right');
    const cw = (p.W - 148) / 3;
    const ways = [['pickType', '⌨', 'Type it', 'Keyboard. Stays as text.'], ['pickHand', '✎', 'Write by hand', 'Your fingertip makes a post-it.'], ['pickVoice', '🎙', 'Voice memo', 'Hold the mic and talk.']] as const;
    ways.forEach(([id, icon, title, desc], i) => {
      const x = 50 + i * (cw + 24);
      p.box(x, 120, cw, 270, i === 1 ? 'rgba(43,42,39,0.07)' : 'rgba(43,42,39,0.06)', 36);
      if (i === 1) { g.strokeStyle = INK; g.lineWidth = 4; g.beginPath(); g.roundRect(x, 120, cw, 270, 36); g.stroke(); }
      p.text(icon, x + 28, 166, 44, INK);
      p.text(title, x + 28, 216, 32, INK, 'left', 'bold');
      p.wrap(desc, x + 28, 254, cw - 56, 22, INK, '', 28, 2);
      p.button(id, x, 120, cw, 270);
    });
    p.box(78, 322, cw - 56, 46, 'rgba(43,42,39,0.06)', 14);
    p.text('Best ramen ever.', 94, 345, 22, INK);
    g.save(); g.translate(50 + cw + 24 + 28, 318); g.rotate(-0.05);
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 16; g.shadowOffsetY = 8;
    p.box(0, 0, cw - 56, 54, PAPERS[0], 6); g.shadowColor = 'transparent';
    g.font = `34px ${HAND}`; g.fillStyle = '#000'; g.textAlign = 'left'; g.fillText('Ramen again', 16, 29);
    g.restore();
    const vx = 50 + 2 * (cw + 24) + 28;
    p.box(vx, 322, cw - 56, 46, 'rgba(43,42,39,0.06)', 23);
    p.text('▶', vx + 18, 346, 22, INK);
    for (let k = 0; k < 9; k++) { const bh = 8 + ((k * 7) % 5) * 5; p.box(vx + 50 + k * 10, 345 - bh / 2, 5, bh, INK2, 2); }
    p.text('0:12', vx + cw - 70, 346, 20, INK, 'right');
    p.text('Mix them on the same day.', 50, 425, 26, INK);
    p.done();
  }

  /** Voice memo: pinch and hold the mic to record, then play it back or stick it on the page. */
  private drawVoice() {
    const p = this.voiceP, rec = !!this.recorder, take = this.take;
    if (!p.mesh.visible && this.mode === 'record') return;
    p.begin(); p.paper();
    p.text('Voice memo', 50, 74, 52, INK, 'left', 'bold');
    p.text(`${weekday(this.editDay)}, ${mmdd(this.editDay)}`, p.W - 50, 80, 30, INK, 'right');
    p.dot(150, 230, 86, rec ? '#ff375f' : 'rgba(43,42,39,0.11)');
    if (rec) { const g = p.g; g.strokeStyle = '#ff375f88'; g.lineWidth = 6; g.beginPath(); g.arc(150, 230, 96 + 6 * Math.sin(this.t * 8), 0, 7); g.stroke(); }
    p.text('🎙', 150, 236, 70, INK, 'center');
    p.button('rec', 64, 144, 172, 172);
    const status = rec ? `Recording  ${clock(this.t - this.recStart)}` : this.voiceErr || (take ? `Recorded ${clock(take.sec)}` : 'Pinch and hold the mic');
    p.wrap(status, 280, 176, p.W - 330, 36, rec ? MARKER : INK, 'bold', 44, 2);
    p.text(rec ? 'Let go to stop.' : `Talk while you hold it. Up to ${VOICE_MAX} s.`, 280, 262, 26, INK2);
    p.button('playTake', 280, 300, 180, 64, this.voicePlayer ? '■  Stop' : '▶  Play', take ? 'rgba(43,42,39,0.11)' : 'rgba(43,42,39,0.06)', take ? INK : INK2, 26);
    p.button('keepVoice', p.W - 300, 300, 250, 64, 'Stick on diary', take ? MARKER : 'rgba(43,42,39,0.12)', take ? '#fff' : INK2, 26);
    p.text('Stays on this device.', 50, 392, 24, INK2);
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
    p.begin(); p.paper();
    p.text('Post-it', 40, 62, 44, INK, 'left', 'bold');
    p.text('Paper color', 40, 122, 28, INK, 'left', 'bold');
    PAPERS.forEach((c, i) => {
      const x = 40 + i * 88;
      p.box(x, 148, 70, 70, c, 16);
      if (i === this.paperC) { g.strokeStyle = INK; g.lineWidth = 5; g.beginPath(); g.roundRect(x - 4, 144, 78, 78, 18); g.stroke(); }
      p.button(`pc${i}`, x, 148, 70, 70);
    });
    const bw = (p.W - 92) / 2;
    p.button('undo', 40, 250, bw, 58, 'Undo stroke', 'rgba(43,42,39,0.09)', INK, 22);
    p.button('wipe', 52 + bw, 250, bw, 58, 'Start over', 'rgba(43,42,39,0.09)', INK, 22);
    p.button('stick', 40, 330, p.W - 80, 66, 'Stick on diary', this.strokes.length ? MARKER : 'rgba(43,42,39,0.15)', this.strokes.length ? '#fff' : INK2, 28);
    p.wrap('Your handwriting stays as you wrote it.', 40, 436, p.W - 80, 22, INK, '', 28, 2);
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
    p.begin(); p.paper();
    p.text(`${MONTHS[m.getMonth()]} ${m.getFullYear()}`, 50, 70, 46, INK, 'left', 'bold');
    p.text(`${keys.length} days · mostly ${MOODS[top].name}`, 50, 122, 28, INK2);
    let x = 50; const bw = p.W - 330; // mood mix bar
    counts.forEach((c, i) => { if (!c) return; const w = bw * c / keys.length; p.box(x, 160, w, 28, MOODS[i].color, 0); x += w; });
    p.button('reel', p.W - 250, 52, 200, 60, '▶ Play month', MARKER, '#fff', 26);
    p.button('recapBack', p.W - 250, 132, 200, 60, 'Back', 'rgba(43,42,39,0.09)', INK, 30);
    p.done();
  }

  private drawMem() {
    const k = this.openDay, d = k ? this.days.get(k) : null;
    if (!k || !d) return;
    const imgs = d.notes ?? []; // post-its float beside the photo
    this.memNotes.forEach((m, i) => { m.mesh.visible = i < imgs.length; if (i < imgs.length) { m.begin(); m.image(imgs[i], 0, 0, m.W, m.H, 8); m.done(); } });
    const p = this.mem, mood = MOODS[d.e.mood ?? 2];
    p.begin(); p.paper();
    p.dot(70, 74, 20, mood.color);
    p.text(`${weekday(k)}, ${mmdd(k)} · ${mood.name}`, 110, 74, 40, INK, 'left', 'bold');
    p.wrap(this.memoText(d.e), 52, 138, p.W - 104, 30, INK, '', 36, 1);
    const vc = this.voiceChip; // the day's voice memo, beside the photo
    vc.mesh.visible = !!d.e.voice;
    if (d.e.voice) {
      vc.begin();
      vc.box(0, 0, vc.W, vc.H, this.voicePlayer ? MARKER : '#fbf7ee', vc.H / 2);
      vc.text(`${this.voicePlayer ? '■' : '▶'}  Voice memo ${clock(d.e.voiceSec ?? 0)}`, vc.W / 2, vc.H / 2, 46, this.voicePlayer ? '#fff' : INK, 'center', 'bold');
      vc.button('playVoice', 0, 0, vc.W, vc.H);
      vc.done();
    }
    const g = p.g;
    g.font = 'bold 30px sans-serif';
    const w1 = g.measureText('Step inside').width + 56, w2 = g.measureText('Back to calendar').width + 56;
    p.button('inside', 50, 172, w1, 60, 'Step inside', MARKER, '#fff', 30);
    p.button('back', 50 + w1 + 16, 172, w2, 60, 'Back to calendar', 'rgba(43,42,39,0.09)', INK, 30);
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
