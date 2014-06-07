'use strict';

var through = require('through2'),
    glob = require('glob'),
    path = require('path'),
    replaceExt = require('replace-ext'),
    gutil = require('gulp-util'),
    fs = require('fs'),
    crypto = require('crypto'),
    PluginError = gutil.PluginError;

var PLUGIN_NAME = 'gulp-include-source';

var PLACEHOLDERS = {
    'js': '<script type="text/javascript" src="%filePath%"></script>',
    'css': '<link rel="stylesheet" href="%filePath%">'
};

var Concat = {
    defaultPathTemplates: '%basePath%/include-files/%type%/%groupName%.%type%',

    createFile: function(filePath, content, group) {
        filePath = filePath.replace(/%basePath%/ig, group.options.basePath);
        filePath = filePath.replace(/%type%/ig, group.type);
        filePath = filePath.replace(/%groupName%/ig, group.groupName);
        filePath = path.normalize(filePath);
        filePath = filePath.basePath.replace(/\\/g, '/');

        console.log(filePath);
        var tmp = path.dirname(filePath);
        if (!fs.existsSync(tmp)) {
            fs.mkdirSync(tmp, '0775');
        }
        fs.writeFileSync(filePath, new Buffer(content));

        return filePath;
    },

    concat: function(files, group) {
        var buffer = [];

        files.forEach(function(filePath) {
            buffer.push(fs.readFileSync(filePath).toString());
        });

        var pathTemplates = group.options.concat.saveTo ? group.options.concat.saveTo : this.defaultPathTemplates;
        var separator = group.options.concat.separator !== undefined ? group.options.concat.separator : '';
        return this.createFile(pathTemplates, buffer.join(separator), group);
    }
};

var Parser = {
    baseRegexpStr: '<!--\\s+include-(css|js):([a-z-0-9\\-_]+)\\(([^)]+)\\)\\s+-->',
    endRegex: '<!-- \\/include-\\2:\\3 -->',

    parsingGroups: function(contents) {
        var regexStr = this.baseRegexpStr;
        var regex = new RegExp(regexStr, 'ig');
        var matches = contents.match(regex);
        regex = new RegExp(regexStr, 'i');
        var data = [];

        for (var i = 0; i < matches.length; i++) {
            var match = matches[i].match(regex);
            data.push({
                type: match[1],
                groupName: match[2],
                options: JSON.parse(match[3])
            });
        }
        return data;
    },

    include: function(contents, includeData, replace) {
        // Remove old include data.
        var regexStr = '(' + this.baseRegexpStr + ')[\\s\\S]*?' + this.endRegex + '\\n*';
        var regex = new RegExp(regexStr, 'i');
        //var matches = contents.match(regex);
        contents = contents.replace(regex, "$1");
        //console.log(includeData);

        // Include new data.
        regexStr = this.baseRegexpStr;
        regex = new RegExp(regexStr, 'i');
        if (replace) {
            contents = contents.replace(regex, includeData);
        } else {
            contents = contents.replace(regex, "$&\n" + includeData + "\n<!-- \\/include-$1:$2 -->\n\n");
        }

        return contents;
    }
};

function getIncludeFiles(source) {
    return glob.sync(source);
}

/**
 * Add md5 string (.v-{hash:9}) to file name, or query string (?_v={hash:9}).
 *
 * @param {string} filePath
 * @param {bool} addQueryString Default false.
 * @param {string} type Date or md5 (get md5 form file). Default: date.
 * @return {string}
 */
function resetCache(filePath, addQueryString, type) {
    try {
        var line = '';
        var data = fs.readFileSync(filePath);
        var hash = '';
        if (type == 'md5') {
            hash = crypto.createHash('md5');
            hash.update(data.toString(), 'utf8');
            hash = hash.digest('hex');
        } else {
            hash = new Date().getTime();
        }

        if (addQueryString) {
            line = filePath.replace(/(.+?)\.(min\.|)(css|js)$/i, '$1.$2$3?_v=' + hash.toString().substr(0, 9));
        } else {
            line = filePath.replace(/(.+?)\.(min\.|)(css|js)$/i, '$1.v-' + hash.toString().substr(0, 9) + '.$2$3');
        }
    }
    catch(e) {
        // fail silently.
    }
    return line;
}

function injectFiles(file, options) {
    var contents = file.contents.toString();
    var groups = Parser.parsingGroups(contents);
    //console.log(groups);

    groups.forEach(function(group) {
        var type = group.type;
        var options = group.options;

        var placeholder = options.template ? options.template : PLACEHOLDERS[type];
        //options.basePath = path.resolve(options.basePath);
        options.basePath = options.basePath.replace(/\\/g, '/');
        var filePath = options.basePath ? path.join(options.basePath, options.src) : options.src;
        var files = getIncludeFiles(filePath);
        var includesData = '';

        if (placeholder && files && files.length > 0) {
            if (options.concat && options.concat.active) {
                var tmp = Concat.concat(files, group);
                files = tmp ? [tmp] : files;
                console.log(files);
            }

            includesData = files.map(function(filePath) {
                // Reset cache.
                if (options.cache && options.cache.active) {
                    filePath = resetCache(filePath, options.cache.addQueryString, options.cache.type);
                }

                // Reset basePath to baseUri.
                if (options.baseUri && options.baseUri != options.basePath) {
                    filePath = filePath.replace(options.basePath, options.baseUri);
                }
                return placeholder.replace('%filePath%', filePath);
            }).join('\n');
        }

        contents = Parser.include(contents, includesData, options.removeThisComment);
        //console.log(contents);
    });

    return contents;
}

module.exports = function(options) {
    options = options || {};

    var stream = through.obj(function (file, enc, callback) {
        if (file.isNull()) {
            this.push(file); // Do nothing if no contents
            return callback();
        }

        if (file.isStream()) {
            this.emit('error', new PluginError(PLUGIN_NAME, 'Streaming not supported!'));
            return callback();
        }

        if (file.isBuffer()) {
            try {
                file.contents = new Buffer(injectFiles(file, options));
            } catch (err) {
                this.emit('error', new gutil.PluginError(PLUGIN_NAME, err));
            }
        }

        this.push(file);
        return callback();
    });

    return stream;
};