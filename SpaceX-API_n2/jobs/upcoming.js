/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */

import got from 'got';
import { load } from 'cheerio';
import * as fuzz from 'fuzzball';
import moment from 'moment-timezone';
import { logger } from '../middleware/index.js';

const REDDIT_WIKI = 'https://old.reddit.com/r/spacex/wiki/launches/manifest';
const API = process.env.SPACEX_API;
const KEY = process.env.SPACEX_KEY;
const HEALTHCHECK = process.env.UPCOMING_HEALTHCHECK;

/**
 * This script gathers dates and payload names from the subreddit launch wiki,
 * fuzzy checks them against existing upcoming mission names and updates the date if a
 * change is made in the wiki. The proper time zone is calculated from the launch site
 * id of the launch. It also corrects the flight number order based on the launch wiki order.
 * @return {Promise<void>}
 */
export default async () => {
  try {
    const flightNumbers = [];
    const rawLaunches = await got.post(`${API}/launches/query`, {
      json: {
        options: {
          pagination: false,
          sort: {
            flight_number: 'asc',
          },
        },
      },
      resolveBodyOnly: true,
      responseType: 'json',
    });

    // Past launches needed to set new flight number order
    const upcoming = rawLaunches.docs.filter((doc) => doc.upcoming === true);
    const past = rawLaunches.docs.filter((doc) => doc.upcoming === false);

    // Grab subreddit wiki
    const rawWiki = await got(REDDIT_WIKI, {
      resolveBodyOnly: true,
    });
    const $ = load(rawWiki);
    const wiki = $('body > div.content > div > div > table:nth-child(7) > tbody').text();

    if (!wiki) {
      throw new Error(`Broken wiki selector: ${wiki}`);
    }

    const wikiRow = wiki.split('\n').filter((v) => v !== '');

    const allWikiDates = wikiRow.filter((_, index) => index % 7 === 0);
    const wikiDates = allWikiDates.slice(0, 30).map((date) => date
      .replace(/(?<=\[[0-9]{2}:[0-9]{2}\])(\[[0-9]{1,3}\]|\[[0-9]{1,3}|[0-9]{1,3}\])*/gi, '')
      .replace(/(?<=\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*)([0-9]{1,3}\])*/gi, '')
      .replace(/~|(\[|\[\[)[0-9]{1,3}\]/gi, '')
      .replace(/~|(\[|\])/gi, '')
      .replace(/(early|mid|late|end|tbd|tba|net)/gi, ' ')
      .replace(/-[0-9]{2}:[0-9]{2}/gi, ' ')
      .replace(/(\(|\)|\?)/gi, ' ') // Removes (?) from dates
      .split('/')[0].trim());
    const rawWikiDates = allWikiDates.slice(0, 30);

    const allWikiPayloads = wikiRow.filter((_, index) => (index + 2) % 7 === 0);
    const wikiPayloads = allWikiPayloads.slice(0, 30).map((payload) => payload.replace(/\[[0-9]{1,3}\]/gi, ''));

    const allWikiLaunchpads = wikiRow.filter((_, index) => (index + 5) % 7 === 0);
    const wikiLaunchpads = allWikiLaunchpads.slice(0, 30).map((launchpad) => launchpad.replace(/\[[0-9]{1,3}\]/gi, ''));

    // Set base flight number to automatically reorder launches on the wiki
    // If the most recent past launch is still on the wiki, don't offset the flight number
    let baseFlightNumber;
    if (fuzz.partial_ratio(past[past.length - 1].name, wikiPayloads[0]) === 100) {
      baseFlightNumber = past[past.length - 1].flight_number;
    } else {
      baseFlightNumber = past[past.length - 1].flight_number + 1;
    }

    // Compare each mission name against entire list of wiki payloads, and fuzzy match the
    // mission name against the wiki payload name. The partial match must be 100%, to avoid
    // conflicts like SSO-A and SSO-B, where a really close match would produce wrong results.
    for await (const [, launch] of upcoming.entries()) {
      // Allow users to pause auto updates from wiki, while still preserving
      // flight reordering feature
      if (!launch.auto_update) {
        continue;
      }
      for await (const [wikiIndex, wikiPayload] of wikiPayloads.entries()) {
        if (fuzz.partial_ratio(launch.name, wikiPayload) === 100) {
          // Special check for starlink / smallsat launches, because Starlink 2 and Starlink 23
          // both pass the partial ratio check, so they are checked strictly below
          if (/starlink/i.test(launch.name) && fuzz.ratio(launch.name, wikiPayload) !== 100) {
            continue;
          }

          // Check and see if dates match a certain pattern depending on the length of the
          // date given. This sets the amount of precision needed for the date.
          // Allows for long months or short months ex: September vs Sep
          // Allows for time with or without brackets ex: [23:45] vs 23:45

          // Anything with NET in date
          const netPattern = /^.*(net).*$/i;

          // Anything with TBD/TBA in date
          const tbdPattern = /^.*(tbd|tba).*$/i;

          // 2020
          const yearPattern = /^\s*[0-9]{4}\s*$/i;

          // 2020 [14:10]
          const yearHourPattern = /^\s*[0-9]{4}\s*(\[?\s*([0-9]{2}|[0-9]{1}):[0-9]{2}\s*\]?)\s*$/i;

          // 2020 Nov
          const monthPattern = /^\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*$/i;

          // 2020 Nov 4
          const dayPattern = /^\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*[0-9]{1,2}\s*$/i;

          // 2020 Nov [14:10]
          const vagueHourPattern = /^\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*(\[?\s*([0-9]{2}|[0-9]{1}):[0-9]{2}\s*\]?)\s*$/i;

          // 2020 Nov 4 [14:10]
          const hourPattern = /^\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*[0-9]{1,2}\s*(\[?\s*([0-9]{2}|[0-9]{1}):[0-9]{2}\s*\]?)\s*$/i;

          // 2020 Nov 4 [14:10:50]
          const secondPattern = /^\s*[0-9]{4}\s*([a-z]{3}|[a-z]{3,9})\s*[0-9]{1,2}\s*(\[?\s*([0-9]{2}|[0-9]{1}):[0-9]{2}:[0-9]{2}\s*\]?)\s*$/i;

          let precision;
          let wikiDate = wikiDates[parseInt(wikiIndex, 10)];
          const rawWikiDate = rawWikiDates[parseInt(wikiIndex, 10)];

          // Check if date is NET
          const net = netPattern.test(rawWikiDate);

          // Check if date contains TBD
          const tbd = tbdPattern.test(rawWikiDate);

          // Remove extra stuff humans might add
          // NOTE: Add to this when people add unexpected things to dates in the wiki
          const cleanedwikiDate = wikiDate;

          // Set date precision
          if (cleanedwikiDate.includes('Q')) {
            // Quarter is first because moment.js does not make
            // a distinction between half vs quarter. Therefore
            // the first half starts at the beginning Q1, and the
            // second half starts at the beginning of Q3
            wikiDate = wikiDate.replace('Q', '');
            precision = 'quarter';
          } else if (cleanedwikiDate.includes('H1')) {
            wikiDate = wikiDate.replace('H1', '1');
            precision = 'half';
          } else if (cleanedwikiDate.includes('H2')) {
            wikiDate = wikiDate.replace('H2', '3');
            precision = 'half';
          } else if (yearPattern.test(cleanedwikiDate)) {
            precision = 'year';
          } else if (yearHourPattern.test(cleanedwikiDate)) {
            precision = 'year';
          } else if (monthPattern.test(cleanedwikiDate)) {
            precision = 'month';
          } else if (dayPattern.test(cleanedwikiDate)) {
            precision = 'day';
          } else if (vagueHourPattern.test(cleanedwikiDate)) {
            precision = 'month';
          } else if (hourPattern.test(cleanedwikiDate)) {
            precision = 'hour';
          } else if (secondPattern.test(cleanedwikiDate)) {
            precision = 'hour';
          } else {
            throw new Error(`No date match: ${cleanedwikiDate}`);
          }

          // Add flight numbers to array to check for duplicates
          flightNumbers.push(baseFlightNumber + wikiIndex);

          // Wiki launchpad matchers
          const slc40Pattern = /^SLC-40.*$/i;
          const lc39aPattern = /^LC-39A.*$/i;
          const slc4ePattern = /^SLC-4E.*$/i;
          const bcPattern = /^BC.*$/i;
          const unknownPattern = /^\?.*$/i;

          // Calculate launch site depending on wiki manifest
          const launchpad = wikiLaunchpads[parseInt(wikiIndex, 10)];
          console.log(launchpad);
          let queryName;
          if (slc40Pattern.test(launchpad)) {
            queryName = 'CCSFS SLC 40';
          } else if (lc39aPattern.test(launchpad)) {
            queryName = 'KSC LC 39A';
          } else if (slc4ePattern.test(launchpad)) {
            queryName = 'VAFB SLC 4E';
          } else if (bcPattern.test(launchpad)) {
            queryName = 'STLS';
          } else if (unknownPattern.test(launchpad)) {
            queryName = 'CCSFS SLC 40';
          } else {
            throw new Error(`No launchpad match: ${launchpad}`);
          }
          const launchpads = await got.post(`${API}/launchpads/query`, {
            json: {
              query: {
                name: queryName,
              },
              options: {
                limit: 1,
              },
            },
            resolveBodyOnly: true,
            responseType: 'json',
          });
          const launchpadId = launchpads.docs[0].id;
          const { timezone } = launchpads.docs[0];

          // Clean wiki date, set timezone
          const parsedDate = `${wikiDates[parseInt(wikiIndex, 10)].replace(/(-|\[|\]|~|early|mid|late|end|net)/gi, ' ').split('/')[0].trim()}`;
          const time = moment(parsedDate, ['YYYY MMM HH:mm:ss', 'YYYY MMM HH:mm', 'YYYY MMM D HH:mm', 'YYYY MMM D', 'YYYY MMM', 'YYYY HH:mm', 'YYYY Q', 'YYYY']);
          const zone = moment.tz(time, 'UTC');
          const localTime = time.tz(timezone).format();

          const rawUpdate = {
            flight_number: (baseFlightNumber + wikiIndex),
            date_unix: zone.unix(),
            date_utc: zone.toISOString(),
            date_local: localTime,
            date_precision: precision,
            launchpad: launchpadId,
            tbd,
            net,
          };

          logger.info({
            launch: launch.name,
            ...rawUpdate,
          });

          await got.patch(`${API}/launches/${launch.id}`, {
            json: {
              ...rawUpdate,
            },
            headers: {
              'spacex-key': KEY,
            },
          });
        }
      }
    }

    if (HEALTHCHECK) {
      await got(HEALTHCHECK);
    }
  } catch (error) {
    console.log(`Upcoming Launch Error: ${error.message}`);
  }
};
