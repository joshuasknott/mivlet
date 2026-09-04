/** Version 1 is stable: saved seeds must keep the same portrait across releases. */
export function createAvatarSeed() {
  return `blob-v1:${crypto.randomUUID()}`;
}

function randomFromSeed(seed: string) {
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762;
  for (let index = 0; index < seed.length; index++) {
    const value = seed.charCodeAt(index);
    a = b ^ Math.imul(a ^ value, 597399067);
    b = c ^ Math.imul(b ^ value, 2869860233);
    c = d ^ Math.imul(c ^ value, 951274213);
    d = a ^ Math.imul(d ^ value, 2716044179);
  }
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const value = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + value;
    return (value >>> 0) / 4294967296;
  };
}

const number = (value: number) => value.toFixed(3);
type Point = { x: number; y: number };

function smoothOutline(points: Point[]) {
  let path = `M${number(points[0].x)} ${number(points[0].y)}`;
  for (let index = 0; index < points.length; index++) {
    const before = points[(index - 1 + points.length) % points.length];
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    path += `C${number(start.x + (end.x - before.x) / 6)} ${number(start.y + (end.y - before.y) / 6)} ${number(end.x - (after.x - start.x) / 6)} ${number(end.y - (after.y - start.y) / 6)} ${number(end.x)} ${number(end.y)}`;
  }
  return `${path}Z`;
}

/** Generates geometry from the whole seed, rather than choosing a preset image. */
export function blobAvatarDataUrl(seed: string) {
  const random = randomFromSeed(seed);
  for (let warmup = 0; warmup < 12; warmup++) random();
  const hue = Math.floor(random() * 360);
  const saturation = 25 + Math.floor(random() * 15);
  const lightness = 69 + Math.floor(random() * 10);
  const count = 7 + Math.floor(random() * 4);
  const width = 23 + random() * 4;
  const height = 23 + random() * 4;
  const angle = random() * Math.PI * 2;
  const points = Array.from({ length: count }, (_, index) => {
    const direction = angle + index * Math.PI * 2 / count;
    const radius = .82 + random() * .2;
    return { x: 32 + Math.cos(direction) * width * radius, y: 32 + Math.sin(direction) * height * radius };
  });
  const outline = smoothOutline(points);
  const faceX = 32 + (random() - .5) * 6;
  const faceY = 31 + (random() - .5) * 5;
  const eyeGap = 9 + random() * 4;
  const eyeRadius = 1.7 + random() * .5;
  const tilt = (random() - .5) * 16;
  const smile = 1.3 + random() * 1.8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><radialGradient id="body" cx="30%" cy="20%" r="85%"><stop stop-color="hsl(${hue} ${saturation}% ${lightness + 12}%)"/><stop offset="1" stop-color="hsl(${hue} ${saturation}% ${lightness}%)"/></radialGradient></defs><path d="${outline}" transform="translate(0 1.5)" fill="#202124" opacity=".09"/><path d="${outline}" fill="url(#body)"/><g transform="rotate(${number(tilt)} ${number(faceX)} ${number(faceY)})" fill="#303037"><circle cx="${number(faceX - eyeGap / 2)}" cy="${number(faceY)}" r="${number(eyeRadius)}"/><circle cx="${number(faceX + eyeGap / 2)}" cy="${number(faceY)}" r="${number(eyeRadius)}"/><path d="M${number(faceX - 2.1)} ${number(faceY + 5.5)}q2.1 ${number(smile)} 4.2 0" fill="none" stroke="#303037" stroke-width="1.35" stroke-linecap="round"/></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
