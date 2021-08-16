const Apify = require('apify');
const _ = require('lodash');
const { SEARCH_TYPES, PAGE_TYPES } = require('./consts');
const errors = require('./errors');

const { log, sleep } = Apify.utils;

// Helper functions that create direct links to search results
const formatPlaceResult = (item) => `https://www.instagram.com/explore/locations/${item.place.location.pk}/${item.place.slug}/`;
const formatUserResult = (item) => `https://www.instagram.com/${item.user.username}/`;
const formatHashtagResult = (item) => `https://www.instagram.com/explore/tags/${item.hashtag.name}/`;

// https://support.perspectiveapi.com/s/about-the-api-attributes-and-languages
// https://www.loc.gov/standards/iso639-2/php/code_list.php
const SUPPORTED_LANGUAGES = [
    'en', // English (en)
    'es', // Spanish (es)
    'fr', // French (fr)
    'de', // German (de)
    'pt', // Portuguese (pt)
    'it', // Italian (it)
    'ru', // Russian (ru)
];

/**
 * Attempts to query Instagram search and parse found results into direct links to instagram pages
 * @param {any} input Input loaded from Apify.getInput();
 * @param {(params: { url: string }) => Promise<any>} request
 */
const searchUrls = async (input, request, retries = 0) => {
    const { hashtag: search, searchType, searchLimit = 1 } = input;
    if (!search) return [];

    try {
        if (!searchType) throw errors.searchTypeIsRequired();
        if (!Object.values(SEARCH_TYPES).includes(searchType)) throw errors.unsupportedSearchType(searchType);
    } catch (error) {
        log.info('--  --  --  --  --');
        log.info(' ');
        log.exception(error.message, 'Run failed because the provided input is incorrect:');
        log.info(' ');
        log.info('--  --  --  --  --');
        process.exit(1);
    }

    log.info(`Searching for "${search}"`);

    // check if the language is supported by Perspective API
    let hl = _.toLower(input.languageCode);

    // try to decode the 3-char encoding to 2-char one
    if (_(SUPPORTED_LANGUAGES).indexOf(hl) === -1) {
        hl = _.get(SUPPORTED_LANGUAGES, hl);
    }

    // defaults to en
    if (_.isEmpty(hl)) {
        hl = "en";
    }

    // const searchUrl = `https://www.instagram.com/web/search/topsearch/?context=${searchType}&query=${encodeURIComponent(search)}`;

    const url = new URL("https://www.instagram.com/web/search/topsearch/");
    const params = new URLSearchParams();

    params.append("context", searchType);
    params.append("query", search);

    // load posts in a particular language
    if (!_.isEmpty(hl)) {
        params.append("hl", hl);
    }

    // inject those query string parameters
    url.search = params.toString();

    const searchUrl = url.href;
    log.info(`instagram search start URL: ${searchUrl}`);

    let body;

    // const { body } = await (async () => {
    //     try {
    //         return await request({
    //             url: searchUrl,
    //         });
    //     } catch (e) {
    //         log.debug('Search', { searchUrl, message: e.message });

    //         return {
    //             body: null,
    //         };
    //     }
    // })();

    const requestList = await Apify.openRequestList('start-urls', [
        searchUrl,
    ]);

    // Proxy connection is automatically established in the Crawler
    const proxyConfiguration = await Apify.createProxyConfiguration(input.proxy);

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        proxyConfiguration,
        handlePageFunction: async ({ page }) => {
            body = await page.evaluate(() => {
                return JSON.parse(document.querySelector('body').innerText);
            });
        },
    });

    console.log('Running Puppeteer script...');
    await crawler.run();
    console.log('Puppeteer closed.');

    log.debug('Response', { body });

    if (!body) {
        if (retries < 10) {
            log.warning(`Server returned non-json answer, retrying ${10 - retries - 1} times`);
            await sleep(500 * (retries + 1));
            return searchUrls(input, request, retries + 1);
        }

        throw new Error('Search is blocked on current proxy IP');
    }

    /** @type {string[]} */
    let urls = [];
    if (searchType === SEARCH_TYPES.USER) urls = body.users.map(formatUserResult);
    else if (searchType === SEARCH_TYPES.PLACE) urls = body.places.map(formatPlaceResult);
    else if (searchType === SEARCH_TYPES.HASHTAG) urls = _(body.hashtags)
        .filter({
            hashtag: {
                name: _.trim(search, '#')
            }
        })
        .map(formatHashtagResult)
        .value();

    log.info(`Found ${urls.length} search results. Limiting to ${searchLimit}.`);
    urls = urls.slice(0, searchLimit);

    return urls;
};

/**
 * Add a location search by ID
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createLocationSearch = (requestQueue) => {
    /**
     * @param {string} locationId
     */
    return async (locationId) => {
        if (+locationId != locationId) {
            Apify.utils.log.warning(`Location id ${locationId} isn't a valid number`);
            return;
        }

        const url = new URL(locationId, 'https://www.instagram.com/explore/locations/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.PLACE,
            },
        });
    };
};

/**
 * Add a hashtag search
 *
 * @param {Apify.RequestQueue} requestQueue
 */
const createHashtagSearch = (requestQueue) => {
    /**
     * @param {string} hashtag
     */
    return async (hashtag) => {
        const url = new URL(`${hashtag}`.replace(/#/g, ''), 'https://www.instagram.com/explore/tags/');

        return requestQueue.addRequest({
            url: url.toString(),
            userData: {
                pageType: PAGE_TYPES.HASHTAG,
            },
        });
    };
};

module.exports = {
    searchUrls,
    createLocationSearch,
    createHashtagSearch,
};
