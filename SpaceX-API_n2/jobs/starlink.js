import got from 'got';
import { CookieJar } from 'tough-cookie';
import Moment from 'moment-timezone';
import MomentRange from 'moment-range';
import { getSatelliteInfo } from 'tle.js';
import { logger } from '../middleware/index.js';

const API = process.env.SPACEX_API;
const KEY = process.env.SPACEX_KEY;
const HEALTHCHECK = process.env.STARLINK_HEALTHCHECK;
const moment = MomentRange.extendMoment(Moment);

/**
 * Generate Starlink version from date
 * @param {Date}    date   Launch date UTC
 * @param {String}  name   Mission name
 * @return {String}
 */
const starlinkVersion = (date, name) => {
  if (!date || !name) {
    return null;
  }
  const missionNameVersion = name.match(/(?<version>v\d{1,3}.\d{1,3})/i)?.groups?.version;
  if (missionNameVersion) {
    return missionNameVersion;
  }
  const parsedDate = moment(date);
  let version = null;
  if (parsedDate.isAfter('2019-11-11')) {
    version = 'v1.0';
  } else if (parsedDate.isAfter('2019-05-24')) {
    version = 'v0.9';
  } else if (parsedDate.isAfter('2018-02-22')) {
    version = 'prototype';
  }
  return version;
};

/**
 * Update Starlink orbits
 * @return {Promise<void>}
 */
export default async () => {
  try {
    const cookieJar = new CookieJar();

    await got.post('https://www.space-track.org/ajaxauth/login', {
      form: {
        identity: process.env.SPACEX_TRACK_LOGIN,
        password: process.env.SPACEX_TRACK_PASSWORD,
      },
      cookieJar,
    });

    const data = await got('https://www.space-track.org/basicspacedata/query/class/gp/OBJECT_NAME/~~STARLINK,~~TINTIN/orderby/NORAD_CAT_ID', {
      responseType: 'json',
      timeout: {
        request: 480000, // 8 minutes
      },
      cookieJar,
    });

    const starlinkSats = data.body.filter((sat) => /starlink|tintin/i.test(sat.OBJECT_NAME));

    const updates = starlinkSats.map(async (sat) => {
      const date = moment.utc(sat.LAUNCH_DATE, 'YYYY-MM-DD');
      const range = date.range('day');

      const launches = await got.post(`${API}/launches/query`, {
        json: {
          query: {
            date_utc: {
              $gte: range.start.toISOString(),
              $lte: range.end.toISOString(),
            },
          },
          options: {
            pagination: false,
          },
        },
        resolveBodyOnly: true,
        responseType: 'json',
      });

      let position;
      if (!(sat.DECAY_DATE)) {
        const tle = [sat.TLE_LINE1, sat.TLE_LINE2];
        try {
          position = await getSatelliteInfo(tle);
        } catch (error) {
          console.log(error);
        }
      }

      await got.patch(`${API}/starlink/${sat.NORAD_CAT_ID}`, {
        json: {
          version: starlinkVersion(
            launches?.docs[0]?.date_utc ?? null,
            launches?.docs[0]?.name ?? null,
          ),
          launch: launches?.docs[0]?.id ?? null,
          longitude: position?.lng ?? null,
          latitude: position?.lat ?? null,
          height_km: position?.height ?? null,
          velocity_kms: position?.velocity ?? null,
          spaceTrack: {
            CCSDS_OMM_VERS: sat.CCSDS_OMM_VERS,
            COMMENT: sat.COMMENT,
            CREATION_DATE: sat.CREATION_DATE,
            ORIGINATOR: sat.ORIGINATOR,
            OBJECT_NAME: sat.OBJECT_NAME,
            OBJECT_ID: sat.OBJECT_ID,
            CENTER_NAME: sat.CENTER_NAME,
            REF_FRAME: sat.REF_FRAME,
            TIME_SYSTEM: sat.TIME_SYSTEM,
            MEAN_ELEMENT_THEORY: sat.MEAN_ELEMENT_THEORY,
            EPOCH: sat.EPOCH,
            MEAN_MOTION: sat.MEAN_MOTION,
            ECCENTRICITY: sat.ECCENTRICITY,
            INCLINATION: sat.INCLINATION,
            RA_OF_ASC_NODE: sat.RA_OF_ASC_NODE,
            ARG_OF_PERICENTER: sat.ARG_OF_PERICENTER,
            MEAN_ANOMALY: sat.MEAN_ANOMALY,
            EPHEMERIS_TYPE: sat.EPHEMERIS_TYPE,
            CLASSIFICATION_TYPE: sat.CLASSIFICATION_TYPE,
            NORAD_CAT_ID: sat.NORAD_CAT_ID,
            ELEMENT_SET_NO: sat.ELEMENT_SET_NO,
            REV_AT_EPOCH: sat.REV_AT_EPOCH,
            BSTAR: sat.BSTAR,
            MEAN_MOTION_DOT: sat.MEAN_MOTION_DOT,
            MEAN_MOTION_DDOT: sat.MEAN_MOTION_DDOT,
            SEMIMAJOR_AXIS: sat.SEMIMAJOR_AXIS,
            PERIOD: sat.PERIOD,
            APOAPSIS: sat.APOAPSIS,
            PERIAPSIS: sat.PERIAPSIS,
            OBJECT_TYPE: sat.OBJECT_TYPE,
            RCS_SIZE: sat.RCS_SIZE,
            COUNTRY_CODE: sat.COUNTRY_CODE,
            LAUNCH_DATE: sat.LAUNCH_DATE,
            SITE: sat.SITE,
            DECAY_DATE: sat.DECAY_DATE,
            DECAYED: !!(sat.DECAY_DATE),
            FILE: sat.FILE,
            GP_ID: sat.GP_ID,
            TLE_LINE0: sat.TLE_LINE0,
            TLE_LINE1: sat.TLE_LINE1,
            TLE_LINE2: sat.TLE_LINE2,
          },
        },
        headers: {
          'spacex-key': KEY,
        },
      });
    });

    await Promise.all(updates);

    logger.info({
      starlinkUpdated: true,
    });

    if (HEALTHCHECK) {
      await got(HEALTHCHECK);
    }
  } catch (error) {
    console.error(error);
    console.log(`Starlink Error: ${error.message}`);
  }
};
