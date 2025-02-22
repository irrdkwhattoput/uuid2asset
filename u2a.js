import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';

const DEFAULT_FILE_EXTENSIONS = ['.json', '.ttf', '.bin', '.png', '.jpg', '.bmp', '.jpeg', '.gif', '.ico', '.tiff', '.webp', '.image', '.pvr', '.pkm', '.mp3', '.ogg', '.wav', '.m4a'];
const CONCURRENT_DOWNLOADS = 400;

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadFile(url, timeout = 30000, delayMs = 5000) {
    let attempt = 1;
    while (true) {
        try {
            const response = await Promise.race([
                fetch(url),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Download timeout')), timeout)
                )
            ]);

            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const buffer = Buffer.from(await response.arrayBuffer());
            return buffer;
        } catch (error) {
            console.error(`\nError downloading ${url}: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            attempt++;
        }
    }
}

async function timeoutProcessor(processor, item, timeout = 30000, delayMs = 5000) {
    let attempt = 1;
    while (true) {
        try {
            const result = await Promise.race([
                processor(item),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Download timeout')), timeout)
                )
            ]);
            return result;
        } catch (error) {
            await delay(delayMs);
            attempt++;
        }
    }
}

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const values = new Array(123);
for (let i = 0; i < 123; ++i) { values[i] = 64; }
for (let i = 0; i < 64; ++i) { values[BASE64_KEYS.charCodeAt(i)] = i; }
const BASE64_VALUES = values;
const HexChars = '0123456789abcdef'.split('');
const _t = ['', '', '', ''];
const UuidTemplate = _t.concat(_t, '-', _t, '-', _t, '-', _t, '-', _t, _t, _t);
const Indices = UuidTemplate.map((x, i) => x === '-' ? NaN : i).filter(isFinite);

function decodeUuid(base64) {
    const strs = base64.split('@');
    const uuid = strs[0];
    if (uuid.length === 9) {
        return base64;
    }
    if (uuid.length !== 22) {
        return base64;
    }
    UuidTemplate[0] = base64[0];
    UuidTemplate[1] = base64[1];
    for (let i = 2, j = 2; i < 22; i += 2) {
        const lhs = BASE64_VALUES[base64.charCodeAt(i)];
        const rhs = BASE64_VALUES[base64.charCodeAt(i + 1)];
        UuidTemplate[Indices[j++]] = HexChars[lhs >> 2];
        UuidTemplate[Indices[j++]] = HexChars[((lhs & 3) << 2) | rhs >> 4];
        UuidTemplate[Indices[j++]] = HexChars[rhs & 0xF];
    }
    return base64.replace(uuid, UuidTemplate.join(''));
}

async function processInBatches(items, batchSize, processor) {
    const results = [];
    let processedCount = 0;
    let successCount = 0;
    let failureCount = 0;
    let retryCount = 0;
    let lastUpdateTime = Date.now();
    const totalItems = items.length;

    console.log(`\n> Starting batch processing of ${totalItems} items...`);

    const subBatchSize = 50;
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchPromises = [];
        
        for (let j = 0; j < batch.length; j += subBatchSize) {
            const subBatch = batch.slice(j, j + subBatchSize);
            const subBatchPromise = Promise.all(subBatch.map(item => 
                timeoutProcessor(processor, item, 30000, 5000)
            ));
            
            batchPromises.push(subBatchPromise.then(subResults => {
                const subBatchSuccess = subResults.filter(r => r !== null).length;
                successCount += subBatchSuccess;
                failureCount += subResults.length - subBatchSuccess;
                processedCount += subResults.length;
                
                const currentTime = Date.now();
                const timeDiff = (currentTime - lastUpdateTime) / 1000;
                const itemsPerSecond = subResults.length / timeDiff;
                lastUpdateTime = currentTime;
                
                process.stdout.write(
                    `\r> Progress: ${processedCount}/${totalItems} ` +
                    `(${Math.round((processedCount/totalItems)*100)}%)`
                );
                
                return subResults;
            }));
        }
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.flat());
    }
    
    return results;
}

async function processBundleData(bundleData, serverName, activeExtensions) {
    const zip = new JSZip();
    let totalFiles = 0;
    let foundFiles = 0;

    if (!bundleData.uuids || !bundleData.versions) {
        console.error('\n[ERROR] Bundle data is missing required fields (uuids or versions)');
        return;
    }

    console.log('\n- Bundle Information:');
    console.log(`- Name: ${bundleData.name}`);
    console.log(`- Total UUIDs: ${bundleData.uuids.length}`);

    const processFile = async ({ url, filePath, baseType, fiveChar }) => {
        try {
            const data = await downloadFile(url);
            if (data) {
                zip.file(filePath, data);
                foundFiles++;
                return { success: true, filePath };
            }
            totalFiles++;
            return { success: false, filePath };
        } catch (error) {
            console.error(`Processing failed for ${filePath}: ${error.message}`);
            totalFiles++;
            return { success: false, filePath, error };
        }
    };

    const processBase = async (baseType) => {
        const base = bundleData[`${baseType}Base`];
        if (!base) {
            console.log(`\n${baseType} base not found in bundle data`);
            return;
        }
        
        const versions = bundleData.versions[baseType];
        if (!versions || !versions.length) {
            console.log(`\nNo versions found for ${baseType} base`);
            return;
        }

        console.log(`\n> Processing ${baseType} base`);

        const downloadTasks = [];

        for (let i = 0; i < versions.length; i += 2) {
            const entry = versions[i];
            const hash = versions[i + 1];
            
            if (typeof entry === 'number') {
                const encryptedUuid = bundleData.uuids[entry];
                const decryptedUuid = decodeUuid(encryptedUuid);
                const firstTwoChars = decryptedUuid.substring(0, 2);

                for (const ext of activeExtensions) {
                    const url = `${serverName}/assets/${bundleData.name}/${base}/${firstTwoChars}/${decryptedUuid}.${hash}${ext}`;
                    const filePath = `${bundleData.name}/${base}/${firstTwoChars}/${decryptedUuid}.${hash}${ext}`;
                    downloadTasks.push({ 
                        url, 
                        filePath,
                        baseType,
                        fiveChar: hash
                    });
                }
            } else {
                const firstTwoChars = entry.substring(0, 2);
                const groupedHash = `${firstTwoChars}/${entry}.${hash}`;

                for (const ext of activeExtensions) {
                    const url = `${serverName}/assets/${bundleData.name}/${base}/${groupedHash}${ext}`;
                    const filePath = `${bundleData.name}/${base}/${groupedHash}${ext}`;
                    downloadTasks.push({ 
                        url, 
                        filePath,
                        baseType,
                        fiveChar: hash
                    });
                }
            }
        }

        console.log(`\n> Created ${downloadTasks.length} download tasks for ${baseType} base`);
        const results = await processInBatches(downloadTasks, CONCURRENT_DOWNLOADS, processFile);    
    };

    await processBase('import');
    await processBase('native');

    if (foundFiles === 0) {
        console.log('\nNo files were found, this probably happened because the bundle config uses a new way to define the file names.');
        return;
    }

    console.log('\nOperation completed, Creating bundle...');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(`${bundleData.name}-bundle.zip`, zipBuffer);
    console.log(`Bundle created: ${bundleData.name}-bundle.zip`);
    console.log(`Total files included: ${foundFiles}`);
}

async function AExtractJS(jsContent) {
    const settingsMatch = jsContent.match(/window\._CCSettings\s*=\s*({[\s\S]*?});/);
    if (settingsMatch) {
        try {
            const window = {};
            eval(`window._CCSettings = ${settingsMatch[1]}`);
            return window._CCSettings;
        } catch (error) {
            console.error('Failed to parse settings:', error);
            return null;
        }
    }
    
    try {
        const settings = JSON.parse(jsContent);
        if (settings.jsList) {
            return settings;
        }
    } catch (e) {
    }
    
    return null;
}

async function automaticDownload(htmlUrl) {
    const baseUrl = htmlUrl.substring(0, htmlUrl.lastIndexOf('/') + 1);
    const mainFiles = [{ url: htmlUrl, path: 'index.html' }];
    const externalZip = new JSZip();
    const bundleConfigs = [];

    const html = await (await fetch(htmlUrl)).text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const addFileToQueue = (path) => {
        const shouldPrefixSrc = path.startsWith('assets/') && !path.startsWith('src/');
        const normalizedPath = shouldPrefixSrc ? `src/${path}` : path;
        const fullUrl = normalizedPath.startsWith('http') 
            ? normalizedPath 
            : new URL(normalizedPath, baseUrl).href;
        
        if (!mainFiles.some(f => f.path === normalizedPath)) {
            mainFiles.push({ url: fullUrl, path: normalizedPath });
        }
    };

    document.querySelectorAll('link[rel="stylesheet"], link[rel="icon"], script[src]').forEach(el => {
        const url = el.getAttribute('href') || el.getAttribute('src');
        if (url) addFileToQueue(url);
    });

    const processJsList = (settings) => {
        if (settings?.jsList) {
            settings.jsList.forEach(path => addFileToQueue(path));
        }
    };

    Array.from(document.getElementsByTagName('script')).forEach(script => {
        if (!script.src) {
            if (script.textContent.includes('_CCSettings')) {
                const settingsFromScript = AExtractJS(script.textContent);
                processJsList(settingsFromScript);
            }
            
            const scriptContent = script.textContent;
            const cocos2dMatch = scriptContent.match(/['"]cocos2d-js(?:-min)?\.([a-zA-Z0-9]+)\.js['"]/);
            if (cocos2dMatch) {
                const fileName = cocos2dMatch[0].replace(/['"]/g, '');
                addFileToQueue(fileName);
            }
            
            const loadScriptMatches = scriptContent.match(/loadScript\([^)]+\)/g);
            if (loadScriptMatches) {
                loadScriptMatches.forEach(match => {
                    const fileMatch = match.match(/['"]([^'"]+)['"]/);
                    if (fileMatch) {
                        addFileToQueue(fileMatch[1]);
                    }
                });
            }
        }
    });

    async function processBundleConfig(bundleName, hash) {
        const configUrl = `${baseUrl}assets/${bundleName}/config.${hash}.json`;
        const mainJsUrl = `${baseUrl}assets/${bundleName}/index.${hash}.js`;
        
        const configData = await downloadFile(configUrl);
        if (!configData) return null;

        externalZip.file(`assets/${bundleName}/config.${hash}.json`, configData);
        
        const mainJsData = await downloadFile(mainJsUrl);
        if (mainJsData) {
            externalZip.file(`assets/${bundleName}/index.${hash}.js`, mainJsData);
            const settingsFromJs = await AExtractJS(mainJsData.toString());
            processJsList(settingsFromJs);
        }
        
        return JSON.parse(configData.toString());
    }

    for (const file of mainFiles) {
        const data = await downloadFile(file.url);
        if (!data) continue;

        externalZip.file(file.path, data);
        
        if (file.path.endsWith('.js')) {
            const fileSettings = await AExtractJS(data.toString());
            processJsList(fileSettings);
            
            if (fileSettings?.bundleVers) {
                for (const [bundle, hash] of Object.entries(fileSettings.bundleVers)) {
                    const bundleConfig = await processBundleConfig(bundle, hash);
                    if (bundleConfig) {
                        bundleConfigs.push({ name: bundle, hash, config: bundleConfig });
                    }
                }
            }
        }
    }

    const externalZipBuffer = await externalZip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync('external-files.zip', externalZipBuffer);
    
    if (bundleConfigs.length > 0) {
        for (const bundle of bundleConfigs) {
            await processBundleData(bundle.config, baseUrl, DEFAULT_FILE_EXTENSIONS);
        }
    }

    console.log(`Download completed: ${mainFiles.length} external files, ${bundleConfigs.length} bundles`);
}

async function main() {
    if (process.argv.length < 3) {
        console.log('Usage: node u2a.js <game-index-html-url>');
        console.log('   or: node u2a.js <server-name> <json-file-name> [<json-file-name>...]');
        console.log('Examples:');
        console.log('  node u2a.js https://example.com/game/v1/index.html (AUTOMATIC, DEBUG ONLY!)');
        console.log('  node u2a.js https://example.com/game/v1/ config.XXXX.json (MANUAL)');
        process.exit(1);
    }

    console.log('\nUUID2Asset Started');

    try {
        if (process.argv.length === 3 && process.argv[2].includes('.html')) {
            await automaticDownload(process.argv[2]);
        } else {
            const args = {
                serverName: process.argv[2],
                bundles: process.argv.slice(3).map(file => ({ file }))
            };

            console.log(`\nTarget Game:`, args.serverName);
            console.log(`\nBundles:`, args.bundles.map(b => b.file).join(', '));

            for (const bundle of args.bundles) {
                const jsonContent = fs.readFileSync(bundle.file, 'utf8');
                const bundleData = JSON.parse(jsonContent);
                await processBundleData(bundleData, args.serverName, DEFAULT_FILE_EXTENSIONS);
            }
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

main();