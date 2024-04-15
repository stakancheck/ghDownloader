// ==UserScript==
// @name         GitHub Downloader
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download GitHub directories and files as ZIP
// @iconURL      https://github.com/stakancheck/ghDownloader/blob/main/assets/icon_gh_downloader.png?raw=true
// @author       Stakancheck
// @match        https://github.com/*/*
// @require      https://update.greasyfork.org/scripts/473358/1237031/JSZip.js
// @grant        none
// ==/UserScript==


// region cheker

// https://github.com/facebook/react/tree/main/.circleci
// https://github.com/facebook/react/tree/main/packages/react-client
const isDirectory = (url) => {
    const pathname = new URL(url).pathname.split("/");
    return pathname.includes("tree") && pathname.length > 5;
};

// https://github.com/facebook/react/blob/main/packages/react-pg/index.js
// https://github.com/facebook/react/blob/main/package.json
const isFile = (url) => {
    const pathname = new URL(url).pathname.split("/");
    return pathname[3] === "blob";
};

// https://github.com/facebook/react
// https://github.com/facebook/react/tree/17.0.2
const isRepository = (url) => {
    const pathname = new URL(url).pathname.split("/").filter((x) => x);
    return (pathname.length === 2 || (pathname.length === 4 && pathname.includes("tree")));
};

const urlChecker = {isRepository, isFile, isDirectory};
// endregion

// region Utility
const saveFile = (blob, fileName) => {
    const a = document.createElement("a");
    document.body.appendChild(a);
    const blobRaw = new Blob([blob], {type: "octet/stream"});
    const url = window.URL.createObjectURL(blobRaw);
    a.href = url;
    a.download = fileName;
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
};

const base64toBlob = async (base64, type = "application/octet-stream") => {
    const res = await fetch(`data:${type};base64,${base64}`);
    return res.blob();
};

const getRepoInfoFromUrl = (url) => {
    const pathname = new URL(url).pathname;
    const [author, repoName, , branch] = pathname.split("/").filter((x) => x);
    const rootDir = pathname.substring(pathname.indexOf(branch) + branch.length + 1);
    return {author, repoName, branch, rootDir};
};

const tokenStore = {
    get: () => localStorage.getItem("gtk"),
};

const outputFactory = (isBlob, fileName, data) => ({isBlob, fileName, data});

// endregion

// region downloadFile
const fetchFile = async (author, repoName, branch, rootDir, token) => {
    const res = await fetch(`https://api.github.com/repos/${author}/${repoName}/contents/${rootDir}?ref=${branch}`, {
        headers: {
            Accept: "application/vnd.github.v3.raw", ...(token && {Authorization: `token ${token}`}),
        },
    });

    if (res.status === 401) {
        throw new Error("invalid token");
    }

    if (res.status === 403) {
        throw new Error("rate limit exceeded");
    }

    if (res.status === 404 && token) {
        throw new Error("repo not found");
    }

    if (res.status === 404 && !token) {
        throw new Error("repo not found, posible is private repo");
    }

    if (!res.ok) {
        throw new Error(`Something went wrong: ${res.statusText} | ${rootDir}`);
    }

    return res.blob();
};

const downloadFile = async (url, token) => {
    const {author, repoName, rootDir, branch} = getRepoInfoFromUrl(url);
    const blob = await fetchFile(author, repoName, branch, rootDir, token);
    return outputFactory(true, rootDir, blob);
};

// endregion


// region downloadDirectory
const isPrivateRepo = async (author, repoName, token) => {
    const header = token ? {
        headers: {
            Authorization: `token ${token}`,
        },
    } : {};

    const res = await fetch(`https://api.github.com/repos/${author}/${repoName}`, header);

    if (res.status === 401) {
        throw new Error("invalid token");
    }

    if (res.status === 403) {
        throw new Error("rate limit exceeded");
    }

    if (res.status === 404 && token) {
        throw new Error("repo not found");
    }

    if (res.status === 404 && !token) {
        throw new Error("repo not found, posible is private repo");
    }

    if (!res.ok) {
        throw new Error(`Something went wrong: ${res.statusText} | ${repoName}`);
    }

    const data = await res.json();
    return data.private;
};

const fetchPrivateFile = async (file, token) => {
    const header = token ? {
        headers: {
            Authorization: `token ${token}`,
        },
    } : {};

    const res = await fetch(file.url, header);
    if (!res.ok) {
        throw new Error(`Something went wrong: ${res.statusText} | ${file.url}`);
    }
    const {content} = await res.json();
    return base64toBlob(content);
};

const fetchPublicFile = async ({author, repoName, branch}, file) => {
    const res = await fetch(`https://raw.githubusercontent.com/${author}/${repoName}/${branch}/${file.path}`);
    if (!res.ok) {
        throw new Error(`Something went wrong: ${res.statusText} | ${file.path}`);
    }
    return res.blob();
};

const getFiles = async (author, repoName, branch, rootDir, token) => {
    const header = token ? {
        headers: {
            Authorization: `token ${token}`,
        },
    } : {};
    const res = await fetch(`https://api.github.com/repos/${author}/${repoName}/git/trees/${branch}?recursive=1`, header);
    const tressData = await res.json();
    const files = [];
    for (const tree of tressData.tree) {
        if (tree.type === "blob" && tree.path.startsWith(rootDir)) {
            files.push(tree);
        }
    }
    return files;
};

const zipFiles = async (files, fetcher) => {
    const zip = new JSZip();
    await Promise.all(files.map(async (file) => {
        const blob = await fetcher(file);
        zip.file(file.path, blob);
    }));
    return zip.generateAsync({type: "blob"});
};

const downloadDirectory = async (targetUrl, token) => {
    const {rootDir, author, branch, repoName} = getRepoInfoFromUrl(targetUrl);
    const isPrivate = await isPrivateRepo(author, repoName, token);
    const files = await getFiles(author, repoName, branch, rootDir, token);

    const fetcher = isPrivate ? (file) => fetchPrivateFile(file, token) : (file) => fetchPublicFile({
        author,
        repoName,
        branch
    }, file);

    const filesZippedBlob = await zipFiles(files, fetcher);
    const fileName = `${repoName}-${rootDir.replace("/", "-")}.zip`;
    return outputFactory(true, fileName, filesZippedBlob);
};

// endregion

// region downloadRepository

const downloadRepository = (targetUrl) => {
    const [, author, repoName, , branch = "master"] = new URL(targetUrl).pathname.split("/");
    const downloadableUrl = `https://github.com/${author}/${repoName}/archive/${branch}.zip`;
    return outputFactory(false, null, downloadableUrl);
};

// endregion

// region downDir

const downloadHandler = async (url, token) => {
    if (urlChecker.isDirectory(url)) {
        return downloadDirectory(url, token);
    }

    if (urlChecker.isFile(url, token)) {
        return downloadFile(url, token);
    }

    if (urlChecker.isRepository(url, token)) {
        return downloadRepository(url);
    }

    throw new Error("Invalid URL");
};

const downDir = async (url, token) => {
    const {isBlob, fileName, data} = await downloadHandler(url, token);
    if (isBlob) {
        saveFile(data, fileName);
    } else {
        window.location.href = data;
    }
};

// endregion


(function () {
    'use strict';

    const token = tokenStore.get(); // Получаем токен из localStorage

    const button = document.createElement('button');
    button.setAttribute('data-component', 'IconButton');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', 'More options');
    button.setAttribute('title', 'Download ZIP');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('data-no-visuals', 'true');
    button.setAttribute('class', 'types__StyledButton-sc-ws60qy-0 kRtIDi');
    button.innerHTML = "<svg aria-hidden=\"true\" focusable=\"false\" role=\"img\" class=\"octicon octicon-download\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"currentColor\"         style=\"display: inline-block; user-select: none; vertical-align: text-bottom; overflow: visible;\">        <path d=\"M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z\"></path>        <path d=\"M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z\"></path>    </svg>"
    button.addEventListener('click', async () => {
        const url = window.location.href; // Текущий URL страницы
        await downDir(url, token); // Вызываем функцию downDir с текущим URL и токеном
    });

    const targetElement = document.querySelector("#StickyHeader > div > div > div.react-code-view-header-element--wide > div > div");
    targetElement.appendChild(button); // Добавляем кнопку на страницу
})();
