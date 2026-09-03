import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId:   'com.ezbyname.familyshopping',
  appName: 'Family Shopping',
  webDir:  '.',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    path: 'android-cap',
  },
};

export default config;
