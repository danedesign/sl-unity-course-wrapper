# SL Unity Course Wrapper Maker

Cross-platform Electron maker for exporting one Unity WebGL course into a Windows wrapper folder or macOS app bundle.

## Workflow

- Open the SL welcome screen and import a WebGL build folder or ZIP.
- The build must contain Unity's index.html and Build output. A ZIP may have one enclosing folder.
- The maker suggests a course name from Unity's loader productName or HTML title. Edit it before export.
- Launch course previews the build in the maker.
- Export wrapper asks for a parent folder, creates a uniquely named course folder, copies the maker's native app shell, embeds the course, and opens the output folder.
- Exported wrappers launch the embedded course directly. Pass --oobe to open the replacement screen. Replacement content is isolated in that wrapper's app-data directory.

The exported native wrapper matches the operating system running the maker. Use the Windows maker to export a Windows wrapper and the Mac maker to export a macOS app bundle. This pilot does not cross-build a course wrapper for both operating systems from one computer.

## Run from source

Install dependencies once, then start the maker:

    npm install
    npm start

For the replacement screen:

    npm run start:oobe

## Build the maker installers

Build the Windows installer on Windows:

    npm run dist:win

Build the macOS DMG and ZIP on macOS:

    npm run dist:mac

The GitHub Actions release workflow builds both platforms and attaches their installers to a version-tag release.

## Technical notes

The Unity content is served through a loopback-only HTTP server, which avoids file:// restrictions and does not expose it to the LAN. Imported courses are staged before replacing the current course.

The pilot's Windows and macOS distributables are unsigned. macOS Gatekeeper may require an override until Developer ID signing and notarization are configured; Windows may show SmartScreen.
