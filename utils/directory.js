const { SWATCH_URIS } = require('./swatches');

const CAT_LIST = [
  { id: 'kuro', name: '黑猫', swatch: SWATCH_URIS.kuro },
  { id: 'mugi', name: '橘猫', swatch: SWATCH_URIS.mugi },
  { id: 'hana', name: '三花猫', swatch: SWATCH_URIS.hana },
  { id: 'shiro', name: '白猫', swatch: SWATCH_URIS.shiro },
  { id: 'saba', name: '银虎斑', swatch: SWATCH_URIS.saba },
  { id: 'hachi', name: '奶牛猫', swatch: SWATCH_URIS.hachi },
  { id: 'sabi', name: '玳瑁猫', swatch: SWATCH_URIS.sabi },
  { id: 'gray', name: '蓝猫', swatch: SWATCH_URIS.gray },
  { id: 'kiji', name: '狸花猫', swatch: SWATCH_URIS.kiji },
  { id: 'siam', name: '暹罗猫', swatch: SWATCH_URIS.siam },
  { id: 'ragdoll', name: '布偶猫', swatch: SWATCH_URIS.ragdoll },
  { id: 'siberian', name: '西伯利亚猫', swatch: SWATCH_URIS.siberian },
  { id: 'norwegian', name: '挪威森林猫', swatch: SWATCH_URIS.norwegian },
];

// [x, y, w, h, fullW, fullH]
const ASSET_DIRECTORY = {
  'grip-slim': [202, 79, 643, 1457, 1024, 1536],
  'hachi': [119, 242, 1113, 461, 1517, 935],
  'hachi-tail': [0, 26, 665, 174, 684, 200],
  'hana': [121, 243, 1110, 457, 1517, 935],
  'hana-tail': [0, 26, 664, 174, 684, 200],
  'hand-slim': [57, 66, 919, 1470, 1024, 1536],
  'kuro': [120, 242, 1112, 461, 1517, 935],
  'kuro-tail': [0, 25, 666, 175, 684, 200],
  'mugi': [120, 242, 1111, 459, 1517, 935],
  'mugi-tail': [0, 27, 664, 173, 684, 200],
  'room': [0, 0, 1517, 935, 1517, 935],
  'sabi': [120, 242, 1112, 461, 1517, 935],
  'sabi-tail': [0, 25, 666, 175, 684, 200],
  'shiro': [120, 244, 1112, 457, 1517, 935],
  'shiro-tail': [0, 28, 663, 172, 684, 200],
  'gray': [120, 242, 1112, 461, 1517, 935],
  'gray-tail': [0, 25, 666, 175, 684, 200],
  'kiji': [120, 244, 1115, 456, 1517, 935],
  'kiji-tail': [0, 23, 662, 177, 684, 200],
  'siam': [123, 244, 1109, 455, 1517, 935],
  'siam-tail': [0, 23, 662, 177, 684, 200],
  'ragdoll': [107, 222, 1143, 494, 1517, 935],
  'ragdoll-tail': [0, 10, 665, 186, 684, 200],
  'siberian': [112, 227, 1120, 505, 1517, 935],
  'siberian-tail': [0, 7, 665, 193, 684, 200],
  'norwegian': [116, 238, 1116, 474, 1517, 935],
  'norwegian-tail': [0, 14, 665, 186, 684, 200],
};

module.exports = {
  CAT_LIST,
  ASSET_DIRECTORY,
};
