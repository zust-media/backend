export default {
  maxFileSizeMB: 50,
  maxBatchCount: 20,
  allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],

  image: {
    defaultQuality: 85,
    maxPreviewWidth: 2560,
    forceWatermark: false,
    defaultWatermark: 'mark.png',
  },

  thumbnail: {
    defaultWidth: 480,
    defaultQuality: 75,
  },

  watermark: {
    marginX: 0.03,
    marginY: 0.03,
    opacity: 0.3,
    sizeRatio: 0.15,
    position: 'bottom-right',
  },

  security: {
    signingKey: 'zustmedia_signing_key_change_me',
  },
};
