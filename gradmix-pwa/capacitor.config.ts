interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir: string;
  server?: {
    androidScheme?: 'http' | 'https';
  };
  ios?: {
    contentInset?: 'automatic' | 'scrollableAxes' | 'never' | 'always';
    allowsLinkPreview?: boolean;
  };
  android?: {
    allowMixedContent?: boolean;
  };
}

const config: CapacitorConfig = {
  appId: 'com.gradmix.app',
  appName: 'GradMix',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
