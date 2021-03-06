'use strict';

var restify = require('restify');
var logger = require('./logger/logger').logger;

var acceptParser = require('./plugin/accept/acceptParser').acceptParser;
var formatXml = require('./plugin/formatter/xml').formatXml;
var formatJSON = restify.formatters['application/json; q=0.4'];
var authorizationParser = require('./plugin/authorization/authorization').authorizationParser;
var cors = require('./plugin/cors').cors;
var requestLogger = require('./plugin/requestLogger').requestLogger;
var etag = require('./plugin/etag').etag;

var InternalError = require('./error/internalError').InternalError;
var NotFoundError = require('./error/notFoundError').NotFoundError;
var BadRequestError = require('./error/badRequestError').BadRequestError;
var ForbiddenError = require('./error/forbiddenError').ForbiddenError;
var ServiceUnavailableError = require('./error/serviceUnavailableError').ServiceUnavailableError;
var MethodNotAllowedError = require('./error/methodNotAllowedError').MethodNotAllowedError;
var ConflictError = require('./error/conflictError').ConflictError;
var UnauthorizedError = require('./error/notAuthorizedError').UnauthorizedError;

var createServer = function createServer(routesMethods, errorHandlers, options) {

  routesMethods = routesMethods || {};
  errorHandlers = errorHandlers || {};
  options = options || {};
  options.appName = options.appName || 'API';
  options.swagger = options.swagger || {};
  options.swagger.enabled = options.swagger.enabled || false;
  options.swagger.apiDocsDir = options.swagger.apiDocsDir || false;
  options.authorization = options.authorization || {};
  options.bodyParser = options.bodyParser || {};
  options.bodyParser.enabled = options.bodyParser.enabled || false;
  options.bodyParser.options = options.bodyParser.options || {};
  options.acceptable = options.acceptable || [];

  var server = restify.createServer(
    {
      name: options.appName,
      formatters: {
        'application/xml': formatXml,
        '*/*': function (req, res, body, cb) {
          formatJSON(req, res, body, function (err, data) {
            res.setHeader('content-type', 'application/json');
            return cb(err, data);
          });
        }
      }
    }
  );

  restify.defaultResponseHeaders = false;

  server.acceptable = server.acceptable.concat(options.acceptable);

  server.on('uncaughtException', function (req, res, route, e) {
    if (res._headerSent) {
      return false;
    }

    logger.error(e);

    res.cache('no-cache', {maxAge: 0});
    res.charSet('utf-8');
    res.send(new InternalError(e.message || 'unexpected error'));
  });

  server.on('MethodNotAllowed', function (req, res/*, err, cb*/) {
    res.cache('public', {maxAge: 3600});
    res.charSet('utf-8');
    res.send(new MethodNotAllowedError(req.method +
        ' is not allowed for resource ' + req._url.pathname)
    );
    //return cb();
  });

  server.on('Unauthorized', function (req, res, err/*, cb*/) {
    res.cache('no-cache', {maxAge: 0});
    res.charSet('utf-8');
    res.send(new UnauthorizedError(err.message));
    //return cb();
  });

  server.on('Internal', function (req, res, err/*, cb*/) {
    res.cache('no-cache', {maxAge: 0});
    res.charSet('utf-8');
    res.send(new InternalError(err.message || 'unexpected error'));
    //return cb();
  });

  server.on('VersionNotAllowed', function (req, res/*, err, cb*/) {
    res.cache('public', {maxAge: 60});
    res.charSet('utf-8');
    res.send(new NotFoundError('Invalid resource version for ' + req._url.pathname));
    //return cb();
  });

  server.on('NotFound', function (req, res/*, err, cb*/) {
    res.cache('public', {maxAge: 3600});
    res.charSet('utf-8');
    res.send(new NotFoundError('Not found resource ' + req._url.pathname));
    //return cb();
  });

  server.on('after', function (req, res/*, route, err*/) {
    if (process.env.hasOwnProperty('NODE_ENV') && process.env.NODE_ENV.indexOf('test') < 0) {
      requestLogger()(req, res, function () {
      });
    }
  });

  for (var errorName in errorHandlers) {
    if (errorHandlers.hasOwnProperty(errorName)) {
      var handler = errorHandlers[errorName];

      (function handle(self, errName, customHandler) {
        logger.debug('Added error handler for "%s"', errName, customHandler);

        self.on(errName, function (req, res, err/*, cb*/) {

          if (res._headerSent) {
            return false;
          }

          var errorResponse;

          switch (customHandler.className) {
            case 'NotFoundError' :
              errorResponse = new NotFoundError(err.message, err.userMessage);
              break;
            case 'BadRequestError' :
              errorResponse = new BadRequestError(err.message, err.userMessage, err.field);
              break;
            case 'ForbiddenError' :
              errorResponse = new ForbiddenError(err.message, err.userMessage);
              break;
            case 'ServiceUnavailableError' :
              errorResponse = new ServiceUnavailableError(err.message, err.userMessage);
              break;
            case 'UnauthorizedError' :
              errorResponse = new UnauthorizedError(err.message, err.userMessage);
              break;
            case 'ConflictError' :
              errorResponse = new ConflictError(err.message, err.userMessage);
              break;
            default :
              errorResponse = new InternalError(err.message);
          }

          res.charSet('utf-8');
          res.send(errorResponse);
          return false;
        });
      }(server, errorName, handler));
    }
  }

  server.pre(acceptParser(server.acceptable));
  server.pre(restify.pre.userAgentConnection());  //curl fix
  server.pre(restify.pre.sanitizePath());
  server.pre(cors());

  server.use(authorizationParser(options.authorization));

  if (options.bodyParser.enabled) {
    server.use(restify.bodyParser(options.bodyParser.options));
  }

  server.use(restify.queryParser());
  server.use(restify.gzipResponse());

  server.use(etag());
  server.use(restify.conditionalRequest());

  for (var method in routesMethods) {
    if (routesMethods.hasOwnProperty(method)) {
      var routers = routesMethods[method];

      routers.forEach(function (route) {

        var methodName = method;

        if (method === 'delete') {
          methodName = 'del';
        }

        if (!route.precondition) {
          route.precondition = function (req, res, next) {
            return next();
          };
        }

        if (method === 'get') {
          server.head(route.options, route.authMethod, route.cache, route.precondition, route.controllerMethod);
        }

        server[methodName](route.options, route.authMethod, route.cache, route.precondition, route.controllerMethod);
      });
    }
  }

  server.get('/_ah/health', function (req, res) {
    res.set('Content-Type', 'text/plain');
    res.status(200).send('ok');
  });

  if (options.swagger.enabled) {

    if (options.swagger.apiDocsDir) {
      server.get(/\/api-docs\/?.*/, restify.serveStatic({
        directory: options.swagger.apiDocsDir,
        default: 'swagger.json'
      }));
    }

    server.get(/\/swagger\/?.*/, restify.serveStatic({
      directory: __dirname + '/public/',
      default: 'index.html'
    }));
  }

  return server;
};

var runServer = function runServer(server, options, callback) {
  var port = process.env.PORT || options.port || 3000;

  server.listen(port, function () {
    logger.info('%s listening at %s', server.name, server.url);
    return callback(null, port);
  });

};

module.exports = {
  createServer: createServer,
  runServer: runServer
};
