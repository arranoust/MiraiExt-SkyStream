# 🌌 MiraiExt
MiraiExt is an extension repo for [SkyStream](https://github.com/akashdh11/skystream). Follow the guide below to get started and set up your providers.

## 🚀 Getting Started

### 1. Installation
To install SkyStream on your device, follow these steps:

*   **Download:** Navigate to the [SkyStream releases page](https://github.com/akashdh11/skystream/releases/) and download the latest release for your platform.
*   **Install:** Open the downloaded file and follow your system's installation prompts.
*   **Launch:** Once installed, open the **SkyStream** app.

---

## 🛠 Setting Up Extensions
SkyStream uses a repository system to fetch plugins. Follow these steps to activate the app's content:

1.  Open the app and navigate to **Settings**.
2.  Select the **Manage Extensions** menu.
3.  Click on the **Add Repository** button.
4.  Enter the following Repository URL:
    > **Repository URL:** `https://raw.githubusercontent.com/arranoust/MiraiExt-SkyStream/main/repo.json`
5.  Tap **Add**.
6.  Wait for the list to populate, then **download** the desired plugins.

---

## 📺 Using the App
After you have installed your plugins, you need to toggle the providers to see content on your dashboard:

1.  Return to the **Home Screen**.
2.  Change **Provider** (bottom right floating action button).
3.  Switch to your newly installed providers to begin browsing.

---

## 🛠 Development

To contribute to this repository or test locally:

1.  **Clone the repo**: `git clone https://github.com/arranoust/MiraiExt-SkyStream.git`
2.  **Install dependencies**: `npm install`
3.  **Add/Update extractors**: `npm install skystream-extractors` (or `npm update skystream-extractors`)
4.  **Test a plugin**: `skystream test -f loadStreams -q "https://example.com/video"`
5.  **Deploy**: Push your changes to the `main` branch; the GitHub Action will automatically bundle and update the repository index.
