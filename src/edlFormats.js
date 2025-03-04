import { XMLParser } from 'fast-xml-parser';
import i18n from 'i18next';

import csvParse from 'csv-parse/lib/browser';
import csvStringify from 'csv-stringify/lib/browser';
import pify from 'pify';
import sortBy from 'lodash/sortBy';

import _ from 'lodash';
import { formatDuration } from './util/duration';
import { invertSegments, sortSegments } from './segments';

const csvParseAsync = pify(csvParse);
const csvStringifyAsync = pify(csvStringify);

export const getTimeFromFrameNum = (detectedFps, frameNum) => frameNum / detectedFps;

export function getFrameCountRaw(detectedFps, sec) {
  if (detectedFps == null) return undefined;
  return Math.round(sec * detectedFps);
}

export async function parseCsv(csvStr, processTime = (t) => t) {
  const rows = await csvParseAsync(csvStr, {});
  if (rows.length === 0) throw new Error(i18n.t('No rows found'));
  if (!rows.every(row => row.length === 3)) throw new Error(i18n.t('One or more rows does not have 3 columns'));

  function parseTimeVal(str) {
    if (str === '') return undefined;
    const parsed = parseFloat(str, 10);
    return processTime(parsed);
  }
  const mapped = rows
    .map(([start, end, name]) => ({
      start: parseTimeVal(start),
      end: parseTimeVal(end),
      name,
    }));

  if (!mapped.every(({ start, end }) => (
    (start === undefined || !Number.isNaN(start))
    && (end === undefined || !Number.isNaN(end))
  ))) {
    console.log(mapped);
    throw new Error(i18n.t('Invalid start or end value. Must contain a number of seconds'));
  }

  return mapped;
}

export async function parseMplayerEdl(text) {
  const allRows = text.split('\n').map((line) => {
    const match = line.match(/^\s*([^\s]+)\s+([^\s]+)\s+([0123])\s*$/);
    if (!match) return undefined;
    const start = parseFloat(match[1]);
    const end = parseFloat(match[2]);
    const type = parseInt(match[3], 10);
    if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
    if (start < 0 || end < 0 || start >= end) return undefined;
    return { start, end, type };
  }).filter((it) => it);

  const cutAwaySegments = allRows.filter((row) => row.type === 0);
  const muteSegments = allRows.filter((row) => row.type === 1);
  const sceneMarkers = allRows.filter((row) => row.type === 2);
  const commercialBreaks = allRows.filter((row) => row.type === 3);

  const inverted = cutAwaySegments.length > 0 ? invertSegments(sortSegments(cutAwaySegments)) : [];

  const map = (segments, name, type) => segments.map(({ start, end }) => ({ start, end, name, tags: { mplayerEdlType: type } }));

  const out = [
    ...map(inverted || [], 'Cut', 0),
    ...map(muteSegments, 'Mute', 1),
    ...map(sceneMarkers, 'Scene Marker', 2),
    ...map(commercialBreaks, 'Commercial Break', 3),
  ];
  if (out.length === 0) throw new Error(i18n.t('Invalid EDL data found'));
  return out;
}

export function parseCuesheet(cuesheet) {
  // There are 75 such frames per second of audio.
  // https://en.wikipedia.org/wiki/Cue_sheet_(computing)
  const fps = 75;

  const { tracks } = cuesheet.files[0];

  function parseTime(track) {
    const index = track.indexes[0];
    if (!index) return undefined;
    const { time } = index;
    if (!time) return undefined;

    return (time.min * 60) + time.sec + time.frame / fps;
  }

  return tracks.map((track, i) => {
    const nextTrack = tracks[i + 1];
    const end = nextTrack && parseTime(nextTrack);

    return { name: track.title, start: parseTime(track), end, tags: { performer: track.performer, title: track.title } };
  });
}

// See https://github.com/mifi/lossless-cut/issues/993#issuecomment-1037090403
export function parsePbf(text) {
  const bookmarks = text.split('\n').map((line) => {
    const match = line.match(/^[0-9]+=([0-9]+)\*([^*]+)*([^*]+)?/);
    if (match) return { time: parseInt(match[1], 10) / 1000, name: match[2] };
    return undefined;
  }).filter((it) => it);

  const out = [];

  for (let i = 0; i < bookmarks.length; i += 2) {
    const bookmark = bookmarks[i];
    const nextBookmark = bookmarks[i + 1];
    out.push({ start: bookmark.time, end: nextBookmark && nextBookmark.time, name: bookmark.name });
  }
  return out;
}

// https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/VersionsoftheInterchangeFormat/VersionsoftheInterchangeFormat.html
export function parseXmeml(xmlStr) {
  const xml = new XMLParser().parse(xmlStr);

  // TODO maybe support media.audio also?
  const { xmeml } = xml;
  if (!xmeml) throw Error('Root element <xmeml> not found in file');

  let sequence;
  if (_.property('project.children.sequence.media.video.track.clipitem')(xmeml)) {
    sequence = xmeml.project.children.sequence;
  } else if (_.property('sequence.media.video.track.clipitem')(xmeml)) {
    sequence = xmeml.sequence;
  } else {
    throw Error('No <clipitem> elements found in file');
  }

  return sequence.media.video.track.clipitem.map((item) => ({ start: item.in / item.rate.timebase, end: item.out / item.rate.timebase }));
}

export function parseYouTube(str) {
  const regex = /(?:([0-9]{2,}):)?([0-9]{1,2}):([0-9]{1,2})(?:\.([0-9]{3}))?[^\S\n]+([^\n]*)\n/g;

  const lines = [];

  function parseLine(match) {
    if (!match) return undefined;
    const [, hourStr, minStr, secStr, msStr, name] = match;
    const hour = hourStr != null ? parseInt(hourStr, 10) : 0;
    const min = parseInt(minStr, 10);
    const sec = parseInt(secStr, 10);
    const ms = msStr != null ? parseInt(msStr, 10) : 0;

    const time = (((hour * 60) + min) * 60 + sec) + ms / 1000;

    return { time, name };
  }

  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = regex.exec(`${str}\n`))) {
    lines.push(parseLine(m));
  }

  const linesSorted = sortBy(lines, (l) => l.time);

  const edl = linesSorted.map((line, i) => {
    const nextLine = linesSorted[i + 1];
    return { start: line.time, end: nextLine && nextLine.time, name: line.name };
  });

  return edl.filter((ed) => ed.start !== ed.end);
}

export function formatYouTube(segments) {
  return segments.map((segment) => {
    const timeStr = formatDuration({ seconds: segment.start, showMs: false, shorten: true });
    const namePart = segment.name ? ` ${segment.name}` : '';
    return `${timeStr}${namePart}`;
  }).join('\n');
}

// because null/undefined is also valid values (start/end of timeline)
const safeFormatDuration = (duration) => (duration != null ? formatDuration({ seconds: duration }) : '');

export const formatSegmentsTimes = (cutSegments) => cutSegments.map(({ start, end, name }) => [
  safeFormatDuration(start),
  safeFormatDuration(end),
  name,
]);

export async function formatCsvFrames({ cutSegments, getFrameCount }) {
  const safeFormatFrameCount = (seconds) => (seconds != null ? getFrameCount(seconds) : '');

  const formatted = cutSegments.map(({ start, end, name }) => [
    safeFormatFrameCount(start),
    safeFormatFrameCount(end),
    name,
  ]);

  return csvStringifyAsync(formatted);
}

export async function formatCsvSeconds(cutSegments) {
  const rows = cutSegments.map(({ start, end, name }) => [start, end, name]);
  return csvStringifyAsync(rows);
}

export async function formatCsvHuman(cutSegments) {
  return csvStringifyAsync(formatSegmentsTimes(cutSegments));
}

export async function formatTsv(cutSegments) {
  return csvStringifyAsync(formatSegmentsTimes(cutSegments), { delimiter: '\t' });
}
