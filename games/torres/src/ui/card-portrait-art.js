const CARD_PORTRAITS = Object.freeze({
  coilblade: Object.freeze({ asset: "card-portraits-painted", cell: 0 }),
  mossguard: Object.freeze({ asset: "card-portraits-painted", cell: 1 }),
  copperskiff: Object.freeze({ asset: "card-portraits-painted", cell: 2 }),
  skymaul: Object.freeze({ asset: "card-portraits-painted", cell: 3 }),
  brassbolt: Object.freeze({ asset: "card-portraits-painted", cell: 4 }),
  reedsting: Object.freeze({ asset: "card-portraits-painted", cell: 5 }),
  "briar-band": Object.freeze({ asset: "card-portraits-painted", cell: 6 }),
  cinderlings: Object.freeze({ asset: "card-portraits-painted", cell: 7 }),
  stonehauler: Object.freeze({ asset: "stonehauler-painted", cell: null }),
  thornscouts: Object.freeze({ asset: "thornscouts-painted", cell: null }),
  forgeguard: Object.freeze({ asset: "forgeguard-painted", cell: null }),
  "squall-orb": Object.freeze({ asset: "squall-orb-painted", cell: null }),
  "cinder-host": Object.freeze({ asset: "cinder-host-painted", cell: null }),
  ironroot: Object.freeze({ asset: "ironroot-painted", cell: null }),
  "sunthread-pair": Object.freeze({ asset: "sunthread-pair-painted", cell: null }),
  "duskwing-trio": Object.freeze({ asset: "duskwing-trio-painted", cell: null }),
  "gloamwing-cluster": Object.freeze({ asset: "gloamwing-cluster-painted", cell: null }),
  "coppershade-flock": Object.freeze({ asset: "coppershade-flock-painted", cell: null }),
  "ember-basin": Object.freeze({ asset: "ember-basin-portrait-painted-v2", cell: null }),
  "buried-coil": Object.freeze({ asset: "buried-coil-portrait", cell: null }),
  kilnkeeper: Object.freeze({ asset: "kilnkeeper-portrait-painted", cell: null }),
  brackenwheel: Object.freeze({ asset: "brackenwheel-portrait-painted", cell: null }),
  "aether-well": Object.freeze({ asset: "aether-well-portrait-painted", cell: null }),
  stormkite: Object.freeze({ asset: "stormkite-portrait-painted", cell: null }),
});

const PORTRAIT_ASSET_PATHS = Object.freeze({
  "card-portraits-painted": new URL(
    "../../public/assets/card-portraits-painted.webp",
    import.meta.url,
  ).href,
  "stonehauler-painted": new URL(
    "../../public/assets/stonehauler-painted.webp",
    import.meta.url,
  ).href,
  "thornscouts-painted": new URL(
    "../../public/assets/thornscouts-painted.webp",
    import.meta.url,
  ).href,
  "forgeguard-painted": new URL(
    "../../public/assets/forgeguard-painted.webp",
    import.meta.url,
  ).href,
  "squall-orb-painted": new URL(
    "../../public/assets/squall-orb-painted.webp",
    import.meta.url,
  ).href,
  "cinder-host-painted": new URL(
    "../../public/assets/cinder-host-painted.webp",
    import.meta.url,
  ).href,
  "ironroot-painted": new URL(
    "../../public/assets/ironroot-painted.webp",
    import.meta.url,
  ).href,
  "sunthread-pair-painted": new URL(
    "../../public/assets/sunthread-pair-painted.webp",
    import.meta.url,
  ).href,
  "duskwing-trio-painted": new URL(
    "../../public/assets/duskwing-trio-painted.webp",
    import.meta.url,
  ).href,
  "gloamwing-cluster-painted": new URL(
    "../../public/assets/gloamwing-cluster-painted.webp",
    import.meta.url,
  ).href,
  "coppershade-flock-painted": new URL(
    "../../public/assets/coppershade-flock-painted.webp",
    import.meta.url,
  ).href,
  "ember-basin-portrait-painted-v2": new URL(
    "../../public/assets/ember-basin-portrait-painted-v2.webp",
    import.meta.url,
  ).href,
  "buried-coil-portrait": new URL(
    "../../public/assets/buried-coil-portrait.webp",
    import.meta.url,
  ).href,
  "kilnkeeper-portrait-painted": new URL(
    "../../public/assets/kilnkeeper-portrait-painted.webp",
    import.meta.url,
  ).href,
  "brackenwheel-portrait-painted": new URL(
    "../../public/assets/brackenwheel-portrait-painted.webp",
    import.meta.url,
  ).href,
  "aether-well-portrait-painted": new URL(
    "../../public/assets/aether-well-portrait-painted.webp",
    import.meta.url,
  ).href,
  "stormkite-portrait-painted": new URL(
    "../../public/assets/stormkite-portrait-painted.webp",
    import.meta.url,
  ).href,
});

export function getCardPortrait(cardId) {
  if (typeof cardId !== "string" || !Object.hasOwn(CARD_PORTRAITS, cardId)) {
    return null;
  }
  const portrait = CARD_PORTRAITS[cardId];
  return Object.freeze({
    ...portrait,
    src: PORTRAIT_ASSET_PATHS[portrait.asset],
  });
}

export function getCardPortraitIds() {
  return Object.keys(CARD_PORTRAITS);
}
