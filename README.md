<div align="center">

# 🌌 MiraiExt for SkyStream

**A curated collection of SkyStream extensions to enhance your streaming experience 🚀**

[![Platform](https://img.shields.io/badge/Platform-Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://www.android.com)
[![Commits](https://img.shields.io/github/commit-activity/m/arranoust/MiraiExt-SkyStream?style=for-the-badge&logo=github)](https://github.com/arranoust/MiraiExt-SkyStream/commits/main)
[![Telegram Channel](https://img.shields.io/badge/Telegram-Channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/arranschannel)

<br>

<img src="banner.jpg" width="100%">

</div>

---

## 🚀 How to Install & Setup

### Step 1: Install SkyStream App
If you haven't installed the app yet, follow these steps:
1. Navigate to the [SkyStream releases page](https://github.com/akashdh11/skystream/releases/) and download the latest release for your platform.
2. Install the downloaded file and open the **SkyStream** app.

### Step 2: Add MiraiExt Repository
SkyStream uses a repository system to fetch plugins. Here is how to add MiraiExt:
1. Open the app and go to **Settings** > **Manage Extensions**.
2. Click on the **Add Repository** button.
3. Copy and paste the following Repository URL:

```text
https://raw.githubusercontent.com/arranoust/MiraiExt-SkyStream/main/repo.json
```
---

## 📺 Using the App
1. Return to the **Home Screen**.
2. Tap the **Provider** button (the floating action button on the bottom right).
3. Switch to your newly installed providers from MiraiExt to begin browsing!

---

<details>
<summary><h2> 📦 Available Extensions </h2></summary>

| No. | Extension | Region | Content Type |
| :--- | :--- | :--- | :--- |
| 1 | **AnimeXin** | EN | Donghua |
| 2 | **Anizone** | EN | Anime |
| 3 | **Cineby** | EN | Movies & Series |
| 4 | **Idlix** | ID | Movies & Series |
| 5 | **LayarKaca** | ID | Movies & Series |
| 6 | **OtakuDesu** | ID | Anime |
| 7 | **Samehadaku** | ID | Anime |
| 8 | **Torrentio** | Global | Torrents |
</details>

> [!WARNING]
> **Disclaimer & Legal Notice**
> 
> We hereby issue this notice to clarify that these extensions function similarly to a standard web browser by fetching video files from the internet.
> - **No content is hosted** by this repository or the SkyStream application.
> - Any content accessed is hosted by third-party websites.
> - Users are solely responsible for their usage and must comply with their local laws.
> 
> If you believe content is violating copyright laws, please contact the **actual file hosts**, not the developers of this repository or the SkyStream app.

---

## 🛠 Development

To contribute to this repository or test locally:

1. **Clone the repo**: `git clone https://github.com/arranoust/MiraiExt-SkyStream.git`
2. **Install dependencies**: `npm install`
3. **Add/Update extractors**: `npm install skystream-extractors` (or `npm update skystream-extractors`)
4. **Test a plugin**: `skystream test -f loadStreams -q "https://example.com/video"`
5. **Deploy**: Push your changes to the `main` branch; the GitHub Action will automatically bundle and update the repository index.

---

<div align="center">
<b>Thank You for using MiraiExt! 🌌</b>
</div>
