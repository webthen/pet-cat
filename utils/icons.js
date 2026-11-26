function getIcons(dark) {
  const t = dark ? 'dark' : 'light';
  return {
    moon: `/assets/icons/moon-${t}.png`,
    sun: `/assets/icons/sun-${t}.png`,
    adjust: `/assets/icons/adjust-${t}.png`,
    soundOff: `/assets/icons/soundOff-${t}.png`,
    soundOn: `/assets/icons/soundOn-${t}.png`,
    rotate: `/assets/icons/rotate-${t}.png`,
    zoomIn: `/assets/icons/zoomIn-${t}.png`,
    zoomOut: `/assets/icons/zoomOut-${t}.png`,
    exit: `/assets/icons/exit-${t}.png`,
    reload: `/assets/icons/reload-${t}.png`,
    check: '/assets/icons/check.png',
    catSmall: `/assets/icons/catSmall-${t}.png`,
    catLarge: `/assets/icons/catLarge-${t}.png`,
    catThin: `/assets/icons/catThin-${t}.png`,
    catWide: `/assets/icons/catWide-${t}.png`,
  };
}

module.exports = { getIcons };
