App({
  onLaunch() {
    if (typeof wx.setInnerAudioOption === 'function') {
      wx.setInnerAudioOption({
        mixWithOther: true,
        obeyMuteSwitch: false,
      });
    }
  },
});
