const CAT_ASSET_LOADERS = {
  'gray': () => require('../assets/cats-js/gray'),
  'gray-tail': () => require('../assets/cats-js/gray-tail'),
  'grip-slim': () => require('../assets/cats-js/grip-slim'),
  'hachi': () => require('../assets/cats-js/hachi'),
  'hachi-tail': () => require('../assets/cats-js/hachi-tail'),
  'hana': () => require('../assets/cats-js/hana'),
  'hana-tail': () => require('../assets/cats-js/hana-tail'),
  'hand-slim': () => require('../assets/cats-js/hand-slim'),
  'kiji': () => require('../assets/cats-js/kiji'),
  'kiji-tail': () => require('../assets/cats-js/kiji-tail'),
  'kuro': () => require('../assets/cats-js/kuro'),
  'kuro-tail': () => require('../assets/cats-js/kuro-tail'),
  'mugi': () => require('../assets/cats-js/mugi'),
  'mugi-tail': () => require('../assets/cats-js/mugi-tail'),
  'norwegian': () => require('../assets/cats-js/norwegian'),
  'norwegian-tail': () => require('../assets/cats-js/norwegian-tail'),
  'ragdoll': () => require('../assets/cats-js/ragdoll'),
  'ragdoll-tail': () => require('../assets/cats-js/ragdoll-tail'),
  'room': () => require('../assets/cats-js/room'),
  'sabi': () => require('../assets/cats-js/sabi'),
  'sabi-tail': () => require('../assets/cats-js/sabi-tail'),
  'shiro': () => require('../assets/cats-js/shiro'),
  'shiro-tail': () => require('../assets/cats-js/shiro-tail'),
  'siam': () => require('../assets/cats-js/siam'),
  'siam-tail': () => require('../assets/cats-js/siam-tail'),
  'siberian': () => require('../assets/cats-js/siberian'),
  'siberian-tail': () => require('../assets/cats-js/siberian-tail'),
};

function getCatAssetBase64(name) {
  const loader = CAT_ASSET_LOADERS[name];
  if (!loader) throw new Error('Unknown cat asset: ' + name);
  return loader();
}

module.exports = { getCatAssetBase64 };
