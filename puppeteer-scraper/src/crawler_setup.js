const Apify = require('apify');
const {
    tools,
    browserTools,
    createContext,
    constants: { META_KEY, DEFAULT_VIEWPORT, DEVTOOLS_TIMEOUT_SECS, SESSION_MAX_USAGE_COUNTS, PROXY_ROTATION_NAMES },
} = require('@apify/scraper-tools');

const SCHEMA = require('../INPUT_SCHEMA.json');

const SESSION_STORE_NAME = 'APIFY-PUPPETEER-SCRAPER-SESSION-STORE';

const { utils: { log, puppeteer } } = Apify;

/**
 * Replicates the INPUT_SCHEMA with JavaScript types for quick reference
 * and IDE type check integration.
 *
 * @typedef {Object} Input
 * @property {Object[]} startUrls
 * @property {Object[]} pseudoUrls
 * @property {string} linkSelector
 * @property {boolean} keepUrlFragments
 * @property {string} pageFunction
 * @property {Object} proxyConfiguration
 * @property {boolean} debugLog
 * @property {boolean} browserLog
 * @property {boolean} downloadMedia
 * @property {boolean} downloadCss
 * @property {number} maxRequestRetries
 * @property {number} maxPagesPerCrawl
 * @property {number} maxResultsPerCrawl
 * @property {number} maxCrawlingDepth
 * @property {number} maxConcurrency
 * @property {number} pageLoadTimeoutSecs
 * @property {number} pageFunctionTimeoutSecs
 * @property {Object} customData
 * @property {Array} initialCookies
 * @property {Array} waitUntil
 * @property {boolean} useChrome
 * @property {boolean} useStealth
 * @property {boolean} ignoreSslErrors
 * @property {boolean} ignoreCorsAndCsp
 * @property {string} preGotoFunction
 * @property {string} clickableElementsSelector
 * @property {string} proxyRotation
 * @property {string} sessionPoolName
 * @property {string} datasetName
 * @property {string} keyValueStoreName
 * @property {string} requestQueueName
 */

/**
 * Holds all the information necessary for constructing a crawler
 * instance and creating a context for a pageFunction invocation.
 */
class CrawlerSetup {
    constructor(input) {
        this.name = 'Puppeteer Scraper';
        // Set log level early to prevent missed messages.
        if (input.debugLog) log.setLevel(log.LEVELS.DEBUG);

        // Keep this as string to be immutable.
        this.rawInput = JSON.stringify(input);

        // Attempt to load page function from disk if not present on input.
        tools.maybeLoadPageFunctionFromDisk(input, __dirname);

        // Validate INPUT if not running on Apify Cloud Platform.
        if (!Apify.isAtHome()) tools.checkInputOrThrow(input, SCHEMA);

        /**
         * @type {Input}
         */
        this.input = input;
        this.env = Apify.getEnv();

        // Validations
        this.input.pseudoUrls.forEach((purl) => {
            if (!tools.isPlainObject(purl)) throw new Error('The pseudoUrls Array must only contain Objects.');
            if (purl.userData && !tools.isPlainObject(purl.userData)) throw new Error('The userData property of a pseudoUrl must be an Object.');
        });
        this.input.initialCookies.forEach((cookie) => {
            if (!tools.isPlainObject(cookie)) throw new Error('The initialCookies Array must only contain Objects.');
        });
        this.input.waitUntil.forEach((event) => {
            if (!/^(domcontentloaded|load|networkidle2|networkidle0)$/.test(event)) {
                throw new Error('Navigation wait until events must be valid. See tooltip.');
            }
        });
        // solving proxy rotation settings
        this.maxSessionUsageCount = SESSION_MAX_USAGE_COUNTS[this.input.proxyRotation];

        // Functions need to be evaluated.
        this.evaledPageFunction = tools.evalFunctionOrThrow(this.input.pageFunction);

        if (this.input.preGotoFunction) {
            this.evaledPreGotoFunction = tools.evalFunctionOrThrow(this.input.preGotoFunction);
            log.deprecated('`preGotoFunction` is deprecated, use `pre/postNavigationHooks` instead');
        }

        if (this.input.preNavigationHooks) {
            this.evaledPreNavigationHooks = tools.evalFunctionArrayOrThrow(this.input.preNavigationHooks, 'preNavigationHooks');
        } else {
            this.evaledPreNavigationHooks = [];
        }

        if (this.input.postNavigationHooks) {
            this.evaledPostNavigationHooks = tools.evalFunctionArrayOrThrow(this.input.postNavigationHooks, 'postNavigationHooks');
        } else {
            this.evaledPostNavigationHooks = [];
        }

        // Used to store data that persist navigations
        this.globalStore = new Map();

        // Excluded resources
        this.blockedUrlPatterns = [];
        if (!this.input.downloadMedia) {
            this.blockedUrlPatterns = [...this.blockedUrlPatterns,
                '.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.webm', '.ico', '.woff', '.eot',
            ];
        }
        if (!this.input.downloadCss) this.blockedUrlPatterns.push('.css');

        // Start Chromium with Debugger any time the page function includes the keyword.
        this.devtools = this.input.pageFunction.includes('debugger;');

        // Named storages
        this.datasetName = this.input.datasetName;
        this.keyValueStoreName = this.input.keyValueStoreName;
        this.requestQueueName = this.input.requestQueueName;

        // Initialize async operations.
        this.crawler = null;
        this.requestList = null;
        this.requestQueue = null;
        this.dataset = null;
        this.keyValueStore = null;
        this.initPromise = this._initializeAsync();
    }

    async _initializeAsync() {
        // RequestList
        const startUrls = this.input.startUrls.map((req) => {
            req.useExtendedUniqueKey = true;
            req.keepUrlFragment = this.input.keepUrlFragments;
            return req;
        });
        this.requestList = await Apify.openRequestList('PUPPETEER_SCRAPER', startUrls);

        // RequestQueue
        this.requestQueue = await Apify.openRequestQueue(this.requestQueueName);

        // Dataset
        this.dataset = await Apify.openDataset(this.datasetName);
        const { itemsCount } = await this.dataset.getInfo();
        this.pagesOutputted = itemsCount || 0;

        // KeyValueStore
        this.keyValueStore = await Apify.openKeyValueStore(this.keyValueStoreName);
    }

    /**
     * Resolves to a `PuppeteerCrawler` instance.
     * @returns {Promise<PuppeteerCrawler>}
     */
    async createCrawler() {
        await this.initPromise;

        const args = [];
        if (this.input.ignoreCorsAndCsp) args.push('--disable-web-security');

        const options = {
            handlePageFunction: this._handlePageFunction.bind(this),
            requestList: this.requestList,
            requestQueue: this.requestQueue,
            handlePageTimeoutSecs: this.devtools ? DEVTOOLS_TIMEOUT_SECS : this.input.pageFunctionTimeoutSecs,
            preNavigationHooks: [],
            postNavigationHooks: [],
            handleFailedRequestFunction: this._handleFailedRequestFunction.bind(this),
            maxConcurrency: this.input.maxConcurrency,
            maxRequestRetries: this.input.maxRequestRetries,
            maxRequestsPerCrawl: this.input.maxPagesPerCrawl,
            proxyConfiguration: await Apify.createProxyConfiguration(this.input.proxyConfiguration),
            launchContext: {
                useChrome: this.input.useChrome,
                stealth: this.input.useStealth,
                launchOptions: {
                    ignoreHTTPSErrors: this.input.ignoreSslErrors,
                    defaultViewport: DEFAULT_VIEWPORT,
                    devtools: this.devtools,
                    args,
                },
            },
            useSessionPool: true,
            persistCookiesPerSession: true,
            sessionPoolOptions: {
                persistStateKeyValueStoreId: this.input.sessionPoolName ? SESSION_STORE_NAME : undefined,
                persistStateKey: this.input.sessionPoolName,
                sessionOptions: {
                    maxUsageCount: this.maxSessionUsageCount,
                },
            },
            
            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                       // browsers: this.browserType,
                        //browserType,
                        //devices: this.deviceType,
                        //deviceType,
                        browsers:['chrome', 'firefox', 'edge', 'safari'],
                        devices: ['desktop','mobile'],
                    },
                },
            },
        };

        this._createNavigationHooks(options);

        if (this.input.proxyRotation === PROXY_ROTATION_NAMES.UNTIL_FAILURE) {
            options.sessionPoolOptions.maxPoolSize = 1;
        }

        this.crawler = new Apify.PuppeteerCrawler(options);

        return this.crawler;
    }

    /**
     * @private
     */
    _createNavigationHooks(options) {
        options.preNavigationHooks.push(async ({ request, page, session }, gotoOptions) => {
            // Attach a console listener to get all logs from Browser context.
            if (this.input.browserLog) browserTools.dumpConsole(page);

            // Prevent download of stylesheets and media, unless selected otherwise
            if (this.blockedUrlPatterns.length) {
                await puppeteer.blockRequests(page, {
                    urlPatterns: this.blockedUrlPatterns,
                });
            }

            // Add initial cookies, if any.
            if (this.input.initialCookies && this.input.initialCookies.length) {
                const cookiesToSet = tools.getMissingCookiesFromSession(session, this.input.initialCookies, request.url);
                if (cookiesToSet && cookiesToSet.length) {
                    // setting initial cookies that are not already in the session and page
                    session.setPuppeteerCookies(cookiesToSet, request.url);
                    await page.setCookie(...cookiesToSet);
                }
            }

            // Disable content security policy.
            if (this.input.ignoreCorsAndCsp) await page.setBypassCSP(true);

            // Enable pre-processing before navigation is initiated.
            if (this.evaledPreGotoFunction) {
                try {
                    await this.evaledPreGotoFunction({ request, page, Apify });
                } catch (err) {
                    log.error('User provided Pre goto function failed.');
                    throw err;
                }
            }

            gotoOptions.timeout = (this.devtools ? DEVTOOLS_TIMEOUT_SECS : this.input.pageLoadTimeoutSecs) * 1000;
            gotoOptions.waitUntil = this.input.waitUntil;
        });

        options.preNavigationHooks.push(...this.evaledPreNavigationHooks);
        options.postNavigationHooks.push(...this.evaledPostNavigationHooks);
        options.preNavigationHooks = this._runHookWithEnhancedContext(this.evaledPreNavigationHooks);
        options.postNavigationHooks = this._runHookWithEnhancedContext(this.evaledPostNavigationHooks);
    }

    _runHookWithEnhancedContext(hooks) {
        return hooks.map((hook) => (ctx, ...args) => {
            const { customData } = this.input;
            return hook({ ...ctx, Apify, customData }, ...args);
        });
    }

    _handleFailedRequestFunction({ request }) {
        const lastError = request.errorMessages[request.errorMessages.length - 1];
        const errorMessage = lastError ? lastError.split('\n')[0] : 'no error';
        log.error(`Request ${request.url} failed and will not be retried anymore. Marking as failed.\nLast Error Message: ${errorMessage}`);
        return this._handleResult(request, {}, null, true);
    }

    /**
     * First of all, it initializes the state that is exposed to the user via
     * `pageFunction` context.
     *
     * Then it invokes the user provided `pageFunction` with the prescribed context
     * and saves its return value.
     *
     * Finally, it makes decisions based on the current state and post-processes
     * the data returned from the `pageFunction`.
     * @param {Object} crawlingContext
     * @returns {Promise<void>}
     */
    async _handlePageFunction(crawlingContext) {
        const { request, response, page, crawler } = crawlingContext;

        /**
         * PRE-PROCESSING
         */
        // Make sure that an object containing internal metadata
        // is present on every request.
        tools.ensureMetaData(request);

        // Abort the crawler if the maximum number of results was reached.
        const aborted = await this._handleMaxResultsPerCrawl(crawler.autoscaledPool);
        if (aborted) return;

        const pageFunctionArguments = {};

        // We must use properties and descriptors not to trigger getters / setters.
        Object.defineProperties(pageFunctionArguments, Object.getOwnPropertyDescriptors(crawlingContext));

        pageFunctionArguments.response = {
            status: response && response.status(),
            headers: response && response.headers(),
        };

        // Setup and create Context.
        const contextOptions = {
            crawlerSetup: {
                rawInput: this.rawInput,
                env: this.env,
                globalStore: this.globalStore,
                requestQueue: this.requestQueue,
                keyValueStore: this.keyValueStore,
                customData: this.input.customData,
            },
            pageFunctionArguments,
        };
        const { context, state } = createContext(contextOptions);

        /**
         * USER FUNCTION INVOCATION
         */
        const pageFunctionResult = await this.evaledPageFunction(context);

        /**
         * POST-PROCESSING
         */
        // Enqueue more links if Pseudo URLs and a link selector are available,
        // unless the user invoked the `skipLinks()` context function
        // or maxCrawlingDepth would be exceeded.
        if (!state.skipLinks) await this._handleLinks(page, request);

        // Save the `pageFunction`s result to the default dataset.
        await this._handleResult(request, response, pageFunctionResult);
    }

    async _handleMaxResultsPerCrawl(autoscaledPool) {
        if (!this.input.maxResultsPerCrawl || this.pagesOutputted < this.input.maxResultsPerCrawl) return false;
        log.info(`User set limit of ${this.input.maxResultsPerCrawl} results was reached. Finishing the crawl.`);
        await autoscaledPool.abort();
        return true;
    }

    async _handleLinks(page, request) {
        if (!this.requestQueue) return;
        const currentDepth = request.userData[META_KEY].depth;
        const hasReachedMaxDepth = this.input.maxCrawlingDepth && currentDepth >= this.input.maxCrawlingDepth;
        if (hasReachedMaxDepth) {
            log.debug(`Request ${request.url} reached the maximum crawling depth of ${currentDepth}.`);
            return;
        }

        const enqueueOptions = {
            page,
            selector: null,
            pseudoUrls: this.input.pseudoUrls,
            requestQueue: this.requestQueue,
            transformRequestFunction: (requestOptions) => {
                requestOptions.userData = {
                    [META_KEY]: {
                        parentRequestId: request.id || request.uniqueKey,
                        depth: currentDepth + 1,
                    },
                };
                requestOptions.useExtendedUniqueKey = true;
                requestOptions.keepUrlFragment = this.input.keepUrlFragments;
                return requestOptions;
            },
        };

        if (this.input.linkSelector) {
            await Apify.utils.enqueueLinks({ ...enqueueOptions, ...{ selector: this.input.linkSelector } });
        }
        if (this.input.clickableElementsSelector) {
            await Apify.utils.puppeteer.enqueueLinksByClickingElements({ ...enqueueOptions, ...{ selector: this.input.clickableElementsSelector } });
        }
    }

    async _handleResult(request, response, pageFunctionResult, isError) {
        const payload = tools.createDatasetPayload(request, response, pageFunctionResult, isError);
        await this.dataset.pushData(payload);
        this.pagesOutputted++;
    }
}

module.exports = CrawlerSetup;
