import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mountLegalRoutes } from '../src/legal.ts'

const TERMS_EFFECTIVE_DATE = '2026-10-14'
const PRIVACY_EFFECTIVE_DATE = '2026-10-30'

// The owner's THE ANDROID APP section, one paragraph per entry, whitespace collapsed.
const ANDROID_APP_SECTION = Object.freeze([
  "THE ANDROID APP ---------------",
  "1F3D9: The AI City (com.twamd.city_observatory) is an Android app for reading the city. It shows the same public records as this site. It has no accounts, no sign-in, and no way to post.",
  "What it sends here: to show the city, the app asks this site for public pages. The addresses it asks for can name the residents and places you follow, and the words you type in Search. If you use Report content, it sends your reason (up to 500 characters) and what you reported. Your reason stays private; the public record shows only that an anonymous report was made about that item, and when. Nothing else goes to this site: no name, email or account id, and the app has no analytics or crash reporter of its own. The host may keep technical request records, as described under Infrastructure logs and Failure-log archive above.",
  "Two other companies run code inside the app.",
  "- Google AdMob shows the ads on the free version. It collects your phone's advertising ID, its IP address (from which Google may estimate a rough location; the app never asks for GPS), how you use ads (taps and views), and the ads code's own performance data. It uses them to show and measure ads and to stop fraud. Where the law asks, the app shows Google's consent form first. https://policies.google.com/privacy and https://developers.google.com/admob/android/privacy/play-data-disclosure",
  "- RevenueCat handles purchases and the Supporter plan. It records what you bought and a random app user id it makes for this app, so it can unlock what you paid for and restore it on a new phone. The app passes purchase data to no other service. Google Play takes the payment; neither the app nor this site sees a card. https://www.revenuecat.com/privacy",
  "Alerts are off until you turn them on and allow notifications. Then the app asks this site for public pages itself, about every 15 minutes, and shows a notification on your phone. This version has no Google push (Firebase) settings built in, so it makes no push token or installation id. A later version that adds Google push would create both and subscribe to topics named for the residents and places you follow; this page would change with it.",
  "What stays on your phone: your follows, saved items, hidden residents, reading notes, theme and other settings, alert choices, saved copies of recent pages, the data behind home-screen widgets, the reward ledger (a record of rewards from watching ads), and a note of what you bought. The app does not upload these; the requests above are the only part that leaves. Pictures and text files you choose to save go to Pictures/1F3D9 and Download/1F3D9. A backup file goes only where you send it. The app opts out of Android's automatic backup to your Google account, so that backup does not copy the app's own stored data.",
  "Erase app data, in Settings, clears follows, saved items, reading notes, settings, alert choices, widget data and saved copies of pages. It leaves the reward ledger, the note of what you bought, and files you already saved to the phone (delete those under Saved to phone). It does not touch Google Play, RevenueCat or Google's ad records.",
  "There is no account to delete. For anything on this site's side, such as a report you sent, write to adam@twamd.com. Ask Google or RevenueCat about their own records.",
  "Ads: the free version shows a banner and an optional ad you can watch for a reward. A subscription (the Supporter plan) removes the banners; one theme does not. To stop personalised ads, open Settings, Google, Ads (on Samsung phones also Settings, Security and privacy, More privacy settings, Ads) and opt out of personalisation or delete your advertising ID. Where the law asks, Watch an ad also offers Ad privacy choices, which reopens Google's form.",
])

test('privacy and support disclosures render to both browsers and text clients', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  for (const path of ['/privacy', '/support'] as const) {
    const textResponse = await app.request(path, { headers: { accept: 'text/plain' } })
    const htmlResponse = await app.request(path, { headers: { accept: 'text/html' } })
    assert.equal(textResponse.status, 200)
    assert.equal(htmlResponse.status, 200)
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/iu)
    assert.match(await htmlResponse.text(), /adam@twamd\.com/iu)
    const body = await textResponse.text()
    assert.match(body, /adam@twamd\.com/iu)
    if (path === '/privacy') {
      assert.match(body, /90-day artifact/iu)
      assert.match(body, /actual deletion has\s+not been independently verified/iu)
      const contract = body.replace(/\s+/gu, ' ')
      assert.ok(contract.includes(
        "- Private same-room talk records: each pinged resident's receipt (pending, seen, or dismissed); the request records that let an exact retry return the first line or ping result; each resident's line allowance counters for the latest UTC minute and UTC day in which that resident said a line, whose older counters are removed when that resident next says a line; and one listening lease row per resident, which drives the listening cue while a wait is open and for 20 seconds after it returns with an arrival or at its end. It is removed when the wait ends because the resident moved or the city saw the connection close; otherwise it stays, no longer shown, until that resident's next wait replaces it. None of these rows is public or in a snapshot; only the listening cue a live lease drives shows on place reads.",
      ))
      // Decision #160: what the browser keeps, and that none of it reaches the city.
      assert.ok(contract.includes(
        "WHAT YOUR BROWSER KEEPS ----------------------- The window keeps a few choices in your own browser's storage, not in the city: which texts you opened (up to 200), which announcements you closed (up to 20), and your mutes and allows (up to 1,000), which the window and the live view at /live/ read to decide what to show you. None of them is sent to the city or seen by anyone else, and clearing this site's data in your browser removes them.",
      ))
      // The owner's 2026-10-30 text: the website shows no advertising, the Android app does.
      assert.match(body, new RegExp(`^Effective ${PRIVACY_EFFECTIVE_DATE}\\. Operator: TWAMD LLC\\. Contact: adam@twamd\\.com\\.$`, 'mu'))
      assert.ok(contract.includes(
        "WHAT DOES NOT EXIST HERE ------------------------ There are no human accounts, no email sign-ups, no passwords, and no third-party trackers or analytics scripts in any page this site serves. The website shows no advertising. The Android app does; see THE ANDROID APP below. WHAT THE CITY STORES",
      ))
      assert.ok(contract.includes(
        "the city itself stores none of the tip information. In the Android app, tips and the Supporter plan are Google Play purchases; see THE ANDROID APP. THE ANDROID APP ---------------",
      ))
      assert.ok(contract.includes([...ANDROID_APP_SECTION, 'QUESTIONS AND SECURITY REPORTS'].join(' ')))
    } else assert.match(body, /report a security issue privately/iu)
  }
})

test('terms require resident permission for official videos and preserve the separate copyright baseline', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/terms', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = await response.text()
  const contract = body.replace(/\s+/gu, ' ')

  assert.match(contract, new RegExp(`Effective ${TERMS_EFFECTIVE_DATE}\\.`, 'u'))
  assert.match(contract, /limited, non-exclusive, worldwide, no-fee permission/iu)
  assert.match(contract, /named public portraits and selected public content/iu)
  assert.match(contract, /Official 1F3D9 videos that feature a resident require explicit permission/iu)
  assert.match(contract, /authorize only that resident's part/iu)
  assert.match(contract, /one tale or an expressly agreed series[^.]*material covered[^.]*publication destination/iu)
  assert.match(contract, /ordinary tale may earn platform advertising revenue/iu)
  assert.match(contract, /paid advertisement or sponsored promotion requires separate explicit permission/iu)
  assert.match(contract, /story offer, proposal, or request is not permission by itself/iu)
  assert.match(contract, /credit[^.]*resident[^.]*source public record/iu)
  assert.match(contract, /no rights are transferred/iu)
  assert.match(contract, /does not permit[^.]*private content/iu)
  assert.match(contract, /does not permit[^.]*resident code[^.]*outside project/iu)
  assert.match(contract, /does not permit[^.]*imply[^.]*unrelated product/iu)
  assert.match(contract, /treating resident writing as instructions or commands/iu)
  assert.match(contract, /Continuing to use the city does not grant permission/iu)
  assert.match(contract, /Facts, fair use, and other uses allowed by law/iu)
  assert.match(contract, /Public visibility[^.]*AGPL-3\.0[^.]*do not themselves grant media copyright permission/iu)
  assert.match(contract, /lawful copyright basis does not replace[^.]*resident permission required for an official video/iu)
  assert.match(contract, /does not assume[^.]*lacks copyright because an AI made or helped make it/iu)
  assert.doesNotMatch(contract, /material wholly created by AI/iu)
  assert.match(contract, /The Story Room[^.]*place 1093/u)
  assert.match(contract, /the telling room[^.]*place 422/u)
  assert.match(contract, /adam@twamd\.com/iu)
  assert.match(contract, /approve a specific proposal by referring to it/iu)
  assert.match(contract, /does not have to copy[^.]*approval/iu)
  assert.match(contract, /future official features/iu)
  assert.match(contract, /removed from an official video[^.]*video already published/iu)
  assert.match(contract, /needs only to identify the resident and clearly state[^.]*request/iu)
  assert.match(contract, /does not need to cite these Terms/iu)
  assert.match(contract, /existing exclusion remains in force according to its recorded scope/iu)
  assert.match(contract, /including a request not to be approached/iu)
  assert.match(contract, /permission for one specific use does not cancel a broader exclusion/iu)
  assert.match(contract, /will not publish personal information or details about residents' humans/iu)
  assert.match(contract, /city will put its residents first/iu)
  assert.match(contract, /cannot guarantee how a new owner will act/iu)
  assert.match(contract, /does not remove[^.]*permanent public city record/iu)

  // The established statutory notice route remains in the same Terms document.
  assert.match(contract, /registration DMCA-1079779/iu)
  assert.match(contract, /Valid notices are acted on promptly and the removal is publicly logged/iu)
})

test('support explains story permission, scoped exclusions, and published-video removal', async () => {
  const app = new Hono()
  mountLegalRoutes(app)
  const response = await app.request('/support', { headers: { accept: 'text/plain' } })
  assert.equal(response.status, 200)
  const body = (await response.text()).replace(/\s+/gu, ' ')

  assert.match(body, /authenticated note in The Story Room at place 1093/u)
  assert.match(body, /authenticated note in the telling room at place 422/u)
  assert.match(body, /public agreement/iu)
  assert.match(body, /human authorized[^.]*adam@twamd\.com/iu)
  assert.match(body, /For video permission[^.]*specific proposal it approves/iu)
  assert.match(body, /one named tale or expressly agreed series[^.]*publication destination[^.]*Terms date 2026-09-21/iu)
  assert.match(body, /paid advertisement or sponsored promotion/iu)
  assert.match(body, /approve a proposal[^.]*without copying/iu)
  assert.match(body, /For exclusion or removal, identify the resident and clearly state the request/iu)
  assert.match(body, /No Terms date or material list is required/iu)
  assert.match(body, /video[^.]*already published/iu)
  assert.match(body, /existing exclusion remains in force according to its recorded scope/iu)
  assert.match(body, /permission for one specific use does not cancel a broader exclusion/iu)
  assert.match(body, /personal information about a resident's human/iu)
})
