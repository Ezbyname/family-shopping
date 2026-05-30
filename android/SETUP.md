# Android TWA Setup Guide

Trusted Web Activity (TWA) — your PWA runs in a full-screen Chrome Custom Tab.
Zero code duplication. Web updates propagate instantly. APK < 1 MB.

## Prerequisites

- Android Studio Hedgehog (2023.1.1+) or newer
- Java 17 SDK
- Google account for Play Console
- Your domain live with HTTPS (Vercel deployment)

---

## Step 1 — Generate a Keystore

```bash
keytool -genkey -v \
  -keystore ~/family-shopping.jks \
  -alias family-shopping \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

Get the SHA-256 fingerprint (you'll need this for assetlinks.json):

```bash
keytool -list -v \
  -keystore ~/family-shopping.jks \
  -alias family-shopping
```

Copy the SHA-256 fingerprint value (format: `AB:CD:EF:...`).

---

## Step 2 — Update assetlinks.json

Edit `/.well-known/assetlinks.json` at the project root:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.familyshopping.app",
    "sha256_cert_fingerprints": ["AB:CD:EF:YOUR:ACTUAL:SHA256:HERE"]
  }
}]
```

Deploy the web app — verify at:
`https://YOUR_DOMAIN/.well-known/assetlinks.json`

---

## Step 3 — Update the Domain in AndroidManifest.xml

Edit `app/src/main/AndroidManifest.xml` — replace both occurrences of:
```
family-shopping.vercel.app
```
with your actual domain.

---

## Step 4 — Add Signing Config to app/build.gradle

Uncomment and fill in the `signingConfigs` block:

```gradle
signingConfigs {
    release {
        storeFile file("/path/to/family-shopping.jks")
        storePassword "your-store-password"
        keyAlias "family-shopping"
        keyPassword "your-key-password"
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        ...
    }
}
```

Alternatively (recommended), store credentials in `~/.gradle/gradle.properties`:
```properties
KEYSTORE_PATH=/path/to/family-shopping.jks
KEYSTORE_PASSWORD=your-store-password
KEY_ALIAS=family-shopping
KEY_PASSWORD=your-key-password
```

And reference them in `build.gradle`:
```gradle
storeFile file(KEYSTORE_PATH)
storePassword KEYSTORE_PASSWORD
```

---

## Step 5 — Add App Icons

Generate icons with Android Asset Studio or from your 512px source:
- `app/src/main/res/mipmap-mdpi/ic_launcher.png`     (48x48)
- `app/src/main/res/mipmap-hdpi/ic_launcher.png`     (72x72)
- `app/src/main/res/mipmap-xhdpi/ic_launcher.png`    (96x96)
- `app/src/main/res/mipmap-xxhdpi/ic_launcher.png`   (144x144)
- `app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`  (192x192)
- Same sizes for `ic_launcher_round.png` (circular crop)

Add a splash image at `app/src/main/res/drawable/splash.png` (512x512, centered logo on dark background).

---

## Step 6 — Build the Release APK / AAB

```bash
cd android
./gradlew bundleRelease       # AAB (required for Play Store)
./gradlew assembleRelease     # APK (for sideloading)
```

Output:
- AAB: `app/build/outputs/bundle/release/app-release.aab`
- APK: `app/build/outputs/apk/release/app-release.apk`

---

## Step 7 — Test Domain Verification

Before submitting to Play Store, verify the TWA runs without the browser bar:

1. Install debug build: `./gradlew installDebug`
2. If the Chrome address bar is visible → assetlinks.json is wrong or not yet deployed
3. Use the Digital Asset Links API to debug:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://YOUR_DOMAIN&relation=delegate_permission/common.handle_all_urls`

---

## Step 8 — Play Store Submission

1. Create a new app in Google Play Console
2. Package name: `com.familyshopping.app`
3. Upload the signed AAB
4. Fill in store listing (see Play Store assets in `android/store-listing/`)
5. Set content rating (Shopping app — no violence/adult content)
6. Add Hebrew language metadata
7. Set price: Free
8. Select countries: Israel (initial), expand later
9. Submit for review (~2-3 days)

---

## Updating the App

No Android rebuild needed for most updates. Just:

1. Deploy web changes to Vercel
2. The TWA loads the updated web app automatically

Android rebuild is required only for:
- Changes to the package name / package structure
- New Android permissions (camera, push notifications)
- Icon changes
- Play Store listing metadata changes

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Chrome address bar visible | assetlinks.json not reachable or SHA-256 mismatch |
| App crashes on launch | Domain not matching manifest intent filter |
| White flash on startup | splash drawable missing or wrong color |
| Location not working | `ACCESS_FINE_LOCATION` permission in manifest (already added) |
| Hebrew text reversed | `android:supportsRtl="true"` in manifest (already added) |
