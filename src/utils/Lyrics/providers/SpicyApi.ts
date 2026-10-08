import Platform from "../../../components/Global/Platform.ts";
import { Query } from "../../API/Query.ts";
import { SLObjPack } from "../../objpack.ts";
import { findSpotifyTrackId } from "./SpotifySearch.ts";
import { GetUnlistedGuesses, GetUnlistedTitles, IsUnlistedItem } from "./index.ts";

const packer = new SLObjPack();

/**
 * Spicy Lyrics' own service for the playing song, asked on demand (the settings
 * panel's "check" and "use"). Null when it has no lyrics. The main pipeline has its
 * own, fuller version of this with retry and queue handling.
 */
export async function FetchSpicyFor(uri: string, isStale: () => boolean = () => false): Promise<any | null> {
  let id: string | null | undefined = uri.split(":")[2];
  if (IsUnlistedItem(uri)) {
    id = await findSpotifyTrackId(GetUnlistedGuesses(), isStale, GetUnlistedTitles());
  }
  if (!id) return null;

  const ask = async (token: string) =>
    (
      await Query(
        [{ operation: "lyrics", variables: { id, auth: "SpicyLyrics-WebAuth" } }],
        { "SpicyLyrics-WebAuth": `Bearer ${token}` }
      )
    ).get("0");

  const token = await Platform.GetSpotifyAccessToken();
  let answer = await ask(token);
  if (answer?.httpStatus === 401) {
    Platform.InvalidateSpotifyAccessToken(token);
    const retry = await Platform.GetSpotifyAccessToken();
    if (retry && retry !== token) answer = await ask(retry);
  }
  if (!answer || answer.httpStatus !== 200) return null;

  const lyrics = packer.unpack(answer.data) as any;
  return lyrics && typeof lyrics === "object" ? lyrics : null;
}
