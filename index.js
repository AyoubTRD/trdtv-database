require("dotenv").config({
    path: __dirname + "/.env",
});

const DEV = process.env["DEV"];

const pupp = require("puppeteer");
const fs = require("fs");

function sleep(delay) {
    return new Promise((resolve) => setTimeout(resolve, delay));
}

function repeat(action, condition, delay) {
    const actionIsPromise = action.constructor.name === "AsyncFunction";
    const conditionIsPromise = condition.constructor.name === "AsyncFunction";

    return new Promise(async (resolve) => {
        while (true) {
            if (actionIsPromise) await action();
            else action();
            await sleep(delay);
            if (conditionIsPromise) {
                if (await condition()) break;
            } else if (condition()) break;
        }
        return resolve();
    });
}

async function closeLastPage(browser) {
    const pages = await browser.pages();
    await pages.pop().close();
}

async function getBasicSerieData() {
    const browser = await pupp.launch({
        headless: !DEV,
    });
    const page = await browser.newPage();
    await page.goto("https://gose.egybest.bid/tv/", {
        timeout: 0,
    });

    await repeat(
        async () => {
            await page.evaluate(() => {
                window.scrollTo({ top: document.body.scrollHeight });
            });
        },
        async () => {
            const numberOfSeries = (await page.$$(".movie")).length;
            console.log(numberOfSeries);
            return numberOfSeries > 500;
        },
        1000
    );

    const series = await page.$$eval(".movie", (series) => {
        return series.map((serie) => ({
            title: serie.querySelector(".title").textContent,
            image: serie.querySelector("img").getAttribute("src"),
            url: serie.getAttribute("href").includes("https://")
                ? serie.getAttribute("href")
                : "https://gose.egybest.bid" + serie.getAttribute("href"),
        }));
    });

    await browser.close();
    return series;
}

async function getFullSerieData(series) {
    const browser = await pupp.launch({
        headless: !DEV,
    });
    const page = await browser.newPage();
    const fullSeries = [];
    for (let i = 0; i < series.length; i++) {
        const serie = series[i];
        const fullSerie = { ...serie };
        try {
            await page.goto(serie.url, {
                timeout: 0,
            });
        } catch {
            console.log("retrying " + serie.title);
            i--;
            continue;
        }
        fullSerie.publicationDate = await page.$eval(
            ".movie_title a",
            (anchor) => anchor.textContent
        );
        fullSerie.image = await page.$eval('[itemprop="image"]', (img) =>
            img.getAttribute("src")
        );
        fullSerie.genres = await page.$$eval(
            "#mainLoad > div:nth-child(1) > div.full_movie.table.full.mgb > div:nth-child(2) > table > tbody > tr:nth-child(4) > td:nth-child(2) a",
            (genres) => genres.map((genre) => genre.textContent)
        );
        fullSerie.story = await page.$eval(
            "#mainLoad > div:nth-child(1) > div:nth-child(5) > div:nth-child(2)",
            (story) => story.textContent
        );
        fullSerie.seasons = await page.$$eval(
            "#mainLoad > div:nth-child(2) > div.h_scroll > div .movie",
            (seasons) =>
                seasons.map((season) => ({
                    url: season.getAttribute("href").includes("https://")
                        ? season.getAttribute("href")
                        : "https://gose.egybest.bid" +
                          season.getAttribute("href"),
                    image: season.querySelector("img").getAttribute("src"),
                    title: season.querySelector(".title").textContent,
                }))
        );

        fullSeries.push(fullSerie);
        console.log("Series Done: " + (i + 1));
        await sleep(400);
    }

    await browser.close();
    return fullSeries;
}

async function getSeasonData(fullSerieData) {
    const browser = await pupp.launch({
        headless: !DEV,
        args: process.env.PROD ? ["--no-sandbox"] : [],
    });
    const page = await browser.newPage();
    for (let j = 0; j < fullSerieData.length; j++) {
        const serie = fullSerieData[j];
        for (let i = 0; i < serie.seasons.length; i++) {
            const season = serie.seasons[i];
            await page.goto(season.url, {
                timeout: 0,
            });
            season.episodes = await page.$$eval(
                "#mainLoad > div:nth-child(3) > div.movies_small .movie",
                (episodes) =>
                    episodes.map((episode) => ({
                        url: episode.getAttribute("href"),
                        title: episode.querySelector(".title").textContent,
                    }))
            );
            await sleep(400);
        }
        console.log("Series Done: " + (j + 1));
    }

    await browser.close();
    return fullSerieData;
}

async function getEpisodeData(seasonData, output) {
    const browser = await pupp.launch({
        headless: !DEV,
    });
    let page = await browser.newPage();
    const done = JSON.parse(fs.readFileSync(output));
    for (let i = done.length; i < seasonData.length; i++) {
        const serie = seasonData[i];
        for (let j = 0; j < serie.seasons.length; j++) {
            const season = serie.seasons[j];
            let tries = 0;
            for (let n = 0; n < season.episodes.length; n++) {
                const episode = season.episodes[n];
                await sleep(400);
                await page.goto(episode.url, {
                    timeout: 0,
                });
                episode.length = await page.$eval(
                    "#mainLoad > div.full_movie.table.full.mgb > div:nth-child(2) > table > tbody > tr:nth-child(7) > td:nth-child(2)",
                    (length) => length.textContent
                );
                episode.qualities = await page.$$eval(
                    "#watch_dl > table > tbody tr",
                    (qualities, episode) =>
                        qualities.map((quality, i) => {
                            return {
                                quality: quality.querySelectorAll("td")[1]
                                    .textContent,
                                size: quality.querySelectorAll("td")[2]
                                    .textContent,
                                source:
                                    episode.qualities &&
                                    episode.qualities[i] &&
                                    episode.qualities[i].source,
                                download:
                                    "https://gose.egybest.bid" +
                                    quality
                                        .querySelectorAll("td")[3]
                                        .querySelector("a")
                                        .getAttribute("data-url"),
                            };
                        }),
                    episode
                );
                const startPages = (await browser.pages()).length;
                await page.evaluate(() => {
                    document.querySelector("tr").click();
                });
                await sleep(5000);
                const endPages = (await browser.pages()).length;
                if (endPages > startPages) await closeLastPage(browser);

                let restart = false;
                for (let l = 0; l < episode.qualities.length; l++) {
                    const quality = episode.qualities[l];
                    if (quality.source) {
                        continue;
                    }
                    await page.goto(quality.download, {
                        timeout: 0,
                    });
                    sleep(1000);
                    if (!page.url().includes("vidstream")) {
                        if (tries < 1) {
                            restart = true;
                            tries++;
                            break;
                        }
                        quality.source = 1;
                        continue;
                    }
                    let episodesDone = 0;
                    while (true) {
                        try {
                            const downloadBtn = await page.$(
                                "body > div.mainbody > div > p:nth-child(4) > a:nth-child(1)"
                            );
                            const downloadURL = await page.$eval(
                                "body > div.mainbody > div > p:nth-child(4) > a:nth-child(1)",
                                (btn) => btn.getAttribute("href")
                            );
                            if (downloadURL) {
                                quality.source = downloadURL;
                                episodesDone++;
                                console.log(
                                    "       Episodes Done: " + episodesDone
                                );
                                break;
                            }
                            await downloadBtn.click();
                            await sleep(4000);
                            closeLastPage(browser);
                            await sleep(5000);
                        } catch {}
                    }
                }
                if (restart) {
                    n--;
                    continue;
                }
                tries = 0;
            }

            console.log("   Seasons Done: " + (j + 1));
        }
        console.log("Series Done: " + (i + 1));
        done.push(serie);
        fs.writeFileSync(output, JSON.stringify(done));
    }
    return done;
}

async function main() {
    let seasonData = JSON.parse(fs.readFileSync("seasonData.json"));
    await getEpisodeData(seasonData.slice(0, 50), "data1.json");
    // await getEpisodeData(seasonData.slice(50, 100), "data2.json");
}

// function start() {
//     main().catch((e) => start());
// }

// start();

main();
