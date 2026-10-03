import { IsPIP } from "../../../../components/Utils/PopupLyrics.ts";

/**
 * "Made by @name" line for lyrics that came from Unison. Mirrors the markup of the
 * Spicy Lyrics community credit (.SongInfo > .Maker) so the same styles apply, and
 * links to the submitter's Unison profile.
 */
export function ApplyUnisonCredit(data: any, LyricsContainer: HTMLElement): void {
  const submitter = data?.UnisonSubmitter;
  if (!submitter?.name || !LyricsContainer) return;

  const songInfoElement = document.createElement("div");
  songInfoElement.classList.add("SongInfo");

  const wrapperSpan = document.createElement("span");
  wrapperSpan.classList.add("Maker");

  const innerSpan = document.createElement("span");

  const labelSpan = document.createElement("span");
  labelSpan.style.opacity = "0.5";
  labelSpan.textContent = "Made by ";

  const profileSectionSpan = document.createElement("span");
  profileSectionSpan.classList.add("song-info-profile-section");
  profileSectionSpan.append("@");

  const usernameSpan = document.createElement("span");
  usernameSpan.textContent = submitter.name;
  profileSectionSpan.appendChild(usernameSpan);

  if (submitter.avatar) {
    const avatarWrapper = document.createElement("span");
    const img = document.createElement("img");
    img.src = submitter.avatar;
    img.alt = `${submitter.name}'s avatar`;
    img.onerror = () => {
      img.style.display = "none";
    };
    avatarWrapper.appendChild(img);
    profileSectionSpan.appendChild(avatarWrapper);
  }

  if (submitter.url) {
    profileSectionSpan.title = "View Unison profile";
    profileSectionSpan.addEventListener("click", () => {
      globalThis.open?.(submitter.url, "_blank", "noopener,noreferrer");
      if (IsPIP) globalThis.focus();
    });
  }

  innerSpan.appendChild(labelSpan);
  innerSpan.appendChild(profileSectionSpan);
  wrapperSpan.appendChild(innerSpan);
  songInfoElement.appendChild(wrapperSpan);
  LyricsContainer.appendChild(songInfoElement);
}
