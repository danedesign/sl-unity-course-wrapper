# SL Unity Course Wrapper Maker

Cross-platform Electron maker for exporting a Unity WebGL course into Windows, macOS, or dual-platform wrapper folders.

## Workflow

- Import a Unity WebGL build folder or ZIP. It must contain index.html and Unity's Build output; a ZIP may have one enclosing folder.
- The maker suggests a course name from Unity's loader productName or HTML title. Edit the name before export.
- Launch course previews the imported course.
- Export wrapper lets you choose Windows, macOS, or both, then select a parent folder. It creates a course-named folder with each selected native app shell and one shared course directory.
- The generated app launches the embedded course immediately. Pass --oobe to reopen the import screen and replace that wrapper's course.

The maker installers include Windows and universal macOS shell templates. The exported macOS app runs on Intel and Apple Silicon. GitHub Actions builds each shell and maker installer on the corresponding OS runner.

## Run from source

Install dependencies once, then start the maker:

    npm install
    npm start

Open the replacement screen during development:

    npm run start:oobe

## Build the maker installers

    npm run dist:win
    npm run dist:mac

The GitHub Actions release workflow builds Windows and macOS installers and attaches them to each version-tag release. It embeds both runtime shell templates in the maker packages, plus updater metadata for the Windows maker. The public repository contains the app source and release downloads.

## Program updates

The packaged maker checks the public GitHub release feed on launch. No account sign-in is required.

When an update is available, choose **Update now** or **Next launch**. Windows downloads the update and offers to restart and install it. macOS checks the release feed and opens the release page; installation remains manual until the app is Developer ID signed and notarized. Exported course wrappers do not check for maker updates; their `--oobe` flow remains for replacing course content.

Release builds include `latest.yml` and blockmaps alongside Windows installer assets for electron-updater. Because this repository and its releases are public, these files contain no private course content or credentials.

## Technical notes

Unity content is served through a loopback-only HTTP server, avoiding file:// restrictions without exposing content to the LAN. Imports are staged before replacing an existing course.

The pilot installers are unsigned. macOS Gatekeeper may require an override until Developer ID signing and notarization are configured; Windows may show SmartScreen.
