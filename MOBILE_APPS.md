# Rent Ledger on Android and iPhone

Rent Ledger runs on phones in two ways:

1. **Installed from the website** (works today): open https://rent-ledger.up.railway.app in Chrome (Android) or Safari (iPhone) and choose *Install app* / *Add to Home Screen*. Updates arrive automatically.
2. **As a real app from Google Play and the App Store** (this guide). The app carries its screens inside it, so it opens instantly, and it talks to the same live server, so your data is the same everywhere.

## What is already set up in the code

- `rent-ledger-source/capacitor.config.json`: the app's name (*Rent Ledger*) and ID (`com.rentledger.app`). Change the ID before your first store upload if you want a different one; it can't be changed afterwards.
- The app signs in to the live server (`https://rent-ledger.up.railway.app`). Nobody has to type a server address.
- The server accepts requests from the Android and iPhone apps.
- Bills, receipts and statements open the phone's share sheet (WhatsApp, Files, Drive…) instead of trying to "download".
- Android's Back button goes to the previous screen, and closes the More panel or a pop-up first.
- Notches, rounded corners and the home bar are respected; text fields don't make the iPhone zoom in.

## One-time setup on your Mac

You need: **Node.js 22**, **Android Studio** (for Android) and **Xcode** from the Mac App Store (for iPhone).

In Terminal:

```
cd ~/Desktop/rent-ledger-cloud-main/rent-ledger-source
npm install
npx cap add android
npx cap add ios
npx cap sync
```

This creates the `android/` and `ios/` folders. Keep them (commit them to GitHub too).

**App icon and splash screen:** put a 1024×1024 PNG of your logo at `rent-ledger-source/assets/icon.png`, then run `npx @capacitor/assets generate`.

## Running on your phone

- **Android:** `npm run android:open`, plug in your phone (with USB debugging on), press ▶ Run in Android Studio.
- **iPhone:** `npm run ios:open`, choose your iPhone at the top of Xcode, sign in with your Apple ID under *Signing & Capabilities*, press ▶ Run.

## After changing the screens

Changes to the server (amounts, bills, PDFs) reach the apps immediately. Changes to the screens (files in `public/`) need:

```
npx cap sync
```

then a new build from Android Studio / Xcode, and a new upload to the stores.

## Publishing

- **Google Play:** create a Google Play Console developer account (one-time fee), then in Android Studio use *Build → Generate Signed App Bundle* and upload the `.aab`.
- **App Store:** join the Apple Developer Program (yearly fee), then in Xcode use *Product → Archive → Distribute App*.

Both stores ask for a privacy policy link (see `PRIVACY.md`), screenshots and a short description.
