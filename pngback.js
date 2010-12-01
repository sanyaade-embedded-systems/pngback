// pngback. A PNG library for Javascript


// make vbuf just array of buffer, offset, len to simplify
// get rid of ended - use end events properly, ie get these functions to check for them
// can stream out buffer data from chunks to next layer out, wg so can start to inflate chunk before checksum
// make eat the usual behaviour, ie most stuff greedy, return proper closures to continue with the partial results 

// merge all the functions into one big one stops the stupid lack of encapsulation shit, and we can store all the state in the function until we fire event

// cant do what we wanted and cleanup to not use vbuf now, as functions not clean any more, too entangled in match. will redo
// although actually I still think that for this case, getting all of chunk data is easier, lets not stream partial chunks

// dont make objects reusble - ie no init methods. Make a new one for a new operation. Create prototypes in right state


// push chunk names and name validation into first pass, so emit name. 
// second pass just ordering, and optional if you dont need it. NO - merging this into first but only enforce forbiddens
// then parsing pass, emits structures - dont listen on ones you dont need, 
// then higher level parse, eg XMP and image data. (XMP needs parse, IDAT a bit odd)
// the levels after ordering pass can be compositional rather than listen ie you construct a listener from an array/args

// make these the same object, but call different routines, that return an instance
// need to link all to an info object, that has the state of the current one, eg header


// todo: 29 Nov
// emit event for new chunk types, so downstream can add listener
// emit IDAT as you get it, with closure storing rest of len for checksum. Then can get rid of vbuf
// maybe though we should send buf, offset, len to parse though, not bytes. else extra copy if dont need them. parse just has to add on. then still need some kind of vbuf, but simpler
// split out the parser into different items that are composed as wanted.
// we dont need to change IDAT though.


var events = require('events');
var crc = require('./crc');

var emitter = new events.EventEmitter(); // need to init to make this work.

// data object for node buffers, a vector of buffers
// fix so that is an array of triples: buffer, offset length, not just one offset, length. Fixes edge cases in truncate if then add more... which can do now ended removed
// hmm, without init all get same buffer! should we make create for our objects?

// 2 options for vbufs: 
// 1. for use in non IDAT blocks, we basically want to copy data, really want array
// 2. for IDAT blocks, we want to send a data stream, just with buf chunks (with offset, len though).
// for IDAT then we would not be able to reconstruct block boundaries. I think thats ok for most apps.
// ideally we want to store all state on block boundary as a closure. Lets see if we can...

// move to a single buffer model, with an offset, not vectors.
// hmm, not good though - means emitting multiple pieces for a single chunk, not one event. So keep vbuf.
// Except maybe for IDAT, where we could emit fake chunks, each exactly from one buffer (singleton vbuf)

// ha, buffer supports slice, so just need array!

// turn into methods, as are png specific? no, fairly general
function to32(bytes) {
	var c = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes [3];
	c = (c < 0) ? 0x100000000 + c: c;
	return c;
}

function to16(bytes) {
	return 256 * bytes[0] + bytes[1];
}

function latinToString(k) {
	for (i = 0; i < k.length; i++) {
		if ((k[i] !== 10 && k[i] < 32) || (k[i] > 126 && k[i] < 160)) {   // valid ISO 8859-1 chars 32-126 and 160-255 + line feed
			return;
		}
	}
	return String.fromCharCode.apply(String, k); // ISO 8859-1 is the same as Unicode code points within this range
}

function asciiToString(k) {
	for (i = 0; i < k.length; i++) {
		if (k[i] < 32 || k[i] > 126) {
			return;
		}
	}
	return String.fromCharCode.apply(String, k);
}

function utf8ToString(bytes) {
	var i = 0;
	var string = "";
	var byte1, byte2, byte3, byte4, num;
	var hi, low;
			
	if (bytes.slice(0, 3) == [0xEF, 0xBB, 0xBF]) { // BOM
		i = 3;
	}

	for( ; i < bytes.length; i++) {
		byte1 = bytes[i];
		if (byte1 < 0x80) {
			num = byte1;
		} else if (byte1 >= 0xC2 && byte1 < 0xE0) {
			byte2 = bytes[++i];
			num = ((byte1 & 0x1F) << 6) + (byte2 & 0x3F);
		} else if (byte1 >= 0xE0 && byte1 < 0xF0) {
			byte2 = bytes[++i];
			byte3 = bytes[++i];
			num = ((byte1 & 0xFF) << 12) + ((byte2 & 0x3F) << 6) + (byte3 & 0x3F);
		} else if (byte1 >= 0xF0 && byte1 < 0xF5) {
			byte2 = bytes[++i];
			byte3 = bytes[++i];
			byte4 = bytes[++i];
			num = ((byte1 & 0x07) << 18) + ((byte2 & 0x3F) << 12) + ((byte3 & 0x3F) << 6) + (byte4 & 0x3F);
		}

		if (num >= 0x10000) { // split it up using surrogates
			num -= 0x10000;

			hi  = (num & 0xFFC00) >> 10; // first 10 bits
			low = num & 0x003FF; // last  10 bits

			hi  += 0xD800; // high surrogate range
			low += 0xDC00; // low surrogate range
			string += String.fromCharCode(hi, low);
		} else {
			string += String.fromCharCode(num);
		}	
	}
	return string;
}

/* png specific from here */

png = Object.create(emitter);

// move back to parse I think! but in this form
png.forbidAfter = { // these are the chunks that are forbidden after other ones
	// corresponds to a weak validation
	IHDR: ['IHDR'],
	PLTE: ['iCCP', 'sRGB', 'sBIT', 'gAMA', 'cHRM'],
	IDAT: ['pHYs', 'sPLT', 'iCCP', 'sRGB', 'sBIT', 'gAMA', 'cHRM', 'tRNS', 'bKGD', 'hIST'],
	gAMA: ['gAMA'],
	sBIT: ['sBIT'],
	bKGD: ['bKGD', 'PLTE'],
	tRNS: ['tRNS', 'PLTE'],
	cHRM: ['cHRM'],
	pHYs: ['pHYs'],
	hIST: ['hIST'],
	tIME: ['tIME'],
	iCCP: ['iCCP', 'sRGB'],
	sRGB: ['iCCP', 'sRGB'],
	IEND: ['*']
};

png.signature = [137, 80, 78, 71, 13, 10, 26, 10];

png.stream = function(stream) { // listen on a stream
	var png = this;
	this.crc = Object.create(crc.crc32);
	var chunk = {};
	var forbidden = [];
	var first = 'IHDR'; // first chunk flag
	
	function unlisten() {
		stream.removeListener('data', data);
		stream.removeListener('end', end);	
	}
	
	function data(buf) {
		var ret;
		var msg = '';
		
		while (typeof png.state == 'function' && buf.length) {
			
			ret = png.state('data', buf);
			
			if (typeof ret == 'object') {
				png.state = ret.f;
				buf = ret.b;
			} else {
				png.state = null;
				msg = ret;
			}
		}
		
		if (typeof png.state !== 'function') {
			unlisten();
			png.emit('bad', msg);
			return;
		}
	}
	
	function end() {
		var ret;
		if (typeof png.state == 'function') {
			ret = png.state('end');
		}
		if (typeof ret == 'undefined') {
			ret = "";
		}
		unlisten();
		if (typeof ret == 'string') {
			png.emit('bad', ret);
		} else {
			png.emit('end');
		}
	}
	
	// note that for get, unlike data we are happy to copy data into array, as we do not send on
	function get(len, match, success, ev, buf, acc) {
		
		function again(ev, buf) {
			return get(len, match, success, ev, buf, acc);
		}
		
		if (ev != 'data') {
			return "unexpected end of stream";
		}

		if (typeof acc == 'undefined') {
			acc = [];
		}

		var max = len - acc.length;
		max = (max > buf.length) ? buf.length : max;

		acc = acc.concat(Array.prototype.slice.call(buf, 0, max));
		
		buf = buf.slice(max);
						
		if (acc.length < len) {
			return {'b': buf, 'f': again};
		}
		
		var ret = match(acc);
		
		if (ret === true) {
			return {'b': buf, 'f': success};
		}

		return ret;
	}
	
	function accept(bytes, success, ev, buf) {
		var compare;
		var c, v;
				
		function again(ev, buf) {
			return accept(compare, success, ev, buf);
		}
		
		if (bytes.length === 0) {
			return {'b': buf, 'f': success};
		}
		
		if (ev != 'data') {
			return "unexpected end of stream";
		}
		
		compare = bytes.slice();
		
		while (compare.length > 0 && buf.length > 0) {
			c = compare.shift();
			v = buf[0];
			buf = buf.slice(1);
			if (c != v) {
				return "failed match";
			}
		}
				
		if (compare.length > 0) {
			return {'b': buf, 'f': again};
		}
		
		return {'b': buf, 'f': success};
	}
	
	function chunkend(ev, buf) {
		if (ev == 'data') {
			return {'b': buf, 'f':chunklen};
		}
		if (ev == 'end') {
			return true;
		}
	}
	
	function chunkcrc(ev, buf) {return get(4, function(bytes) {
			png.crc.finalize();
			var c = to32(bytes);
			if (c !== png.crc.crc) {
				return "failed crc";
			}
			// now emit a chunk event
			png.emit(chunk.name, chunk.data);
			return true;
		}, chunkend, ev, buf);}
		
	function chunkdata(ev, buf, acc, len) {
		
		function again(ev, buf) {
			return chunkdata(ev, buf, acc, len);
		}
		
		if (chunk.length === 0) {
			chunk.data = [];
			return {'b': buf, 'f':chunkcrc};
		}
		
		if (ev === 'end') {
			return "unexpected end of stream";
		}
		
		if (typeof acc == 'undefined') {
			acc = [];
			len = 0;
		}
		
		var max = chunk.length - len;
		max = (max > buf.length) ? buf.length : max;
		
		var sl = buf.slice(0, max);
		png.crc.add(sl);
		
		acc.push(sl);
		
		len += max;
		buf = buf.slice(max);
		
		if (len < chunk.length) {
			return {'b': buf, 'f': again};
		}
		
		chunk.data = acc;
		
		return {'b': buf, 'f':chunkcrc};
	}

	function chunktype(ev, buf) {return get(4, function(bytes) {
			var b;
			for (var i = 0; i < 4; i++) {
				b = bytes[i];
				if (b < 65 || (b > 90 && b < 97) || b > 122) {
					return false;
				}
			}
			if (bytes[2] & 0x10 === 0) {
				return "reserved chunk in stream";
			}
			
			var name = String.fromCharCode.apply(String, bytes);
			chunk.name = name;
			
			if (typeof first == 'string' && first !== name) {
				return "first chunk invalid";
			}
			first = false;
			
			if (forbidden.indexOf('*') !== -1) {
				return "chunk after IEND";
			}
			
			if (forbidden.indexOf(name) !== -1) {
				return "chunk " + name + " not allowed here";
			}
			
			if (name in png.forbidAfter) {
				forbidden.push.apply(Array, png.forbidAfter[name]);
			}
			
			png.crc.start();
			png.crc.add(bytes);
			return true;
		}, chunkdata, ev, buf);}

	function chunklen(ev, buf) {return get(4, function(bytes) {
			if (bytes[0] & 0x80) { // high bit must not be set
				return "bad chunk length";
			}
			chunk.length = to32(bytes);
			// probably a good idea to add a smaller length check here... to stop DoS, optional
			return true;
		}, chunktype, ev, buf);}
	
	function sig(ev, buf) {return accept(png.signature, chunklen, ev, buf);}
	
	this.state = sig;
	
	stream.on('data', data);
	stream.on('end', end);
	
	return this;
};



// some sort of compositional method for putting these together would be nice. Look for methods, etc. Basically a pipe fn that composes.

// next layer is parsing

var cfsm = Object.create(emitter); // no need to inherit from FSM!

// this could be done as state driven too, or at least function based not cases, so extensible.
// pass the functions not the strings then!
// could do incrementally without converting from buffers, but not much point
cfsm.parseField = function(data, fields) {
	var bytes = [];
	var type, name;
	var ret = {};
	var a = [];
	var i, k, s, z;
	var fs = fields.slice();
	
	for (i = 0; i < data.length; i++) {
		bytes = bytes.concat(Array.prototype.slice.call(data[i]));
	}
	
	function zterm() {
		var p = bytes.indexOf(0);
		if (p === -1) {
			return;
		}
		var k = bytes.slice(0, p);
		bytes = bytes.slice(p + 1);
		
		return k;
	}
	
	while(fs.length > 0) {
		name = fs.shift();
		type = fs.shift();
		switch (type) {
			case 'uint8':
				if (bytes.length < 1) {
					return "not enough data";
				}
				ret[name] = bytes[0];
				bytes.shift();
				break;
			case 'uint16':
				if (bytes.length < 2) {
					return "not enough data";
				}
				ret[name] = to16(bytes);
				bytes = bytes.slice(2);
				break;
			case 'uint32':
				if (bytes.length < 4) {
					return "not enough data";
				}
				ret[name] = to32(bytes);
				bytes = bytes.slice(4);
				break;
			case 'float100k':
				if (bytes.length < 4) {
					return "not enough data";
				}
				ret[name] = to32(bytes) / 100000;
				bytes = bytes.slice(4);
				break;
			case 'rgb': // rgb triples, any number
				if (bytes.length % 3 !== 0) {
					return "rgb is not a multiple of 3 bytes";
				}
				while (bytes.length !== 0) {
					a.push({'red': bytes[0], 'green': bytes[1], 'blue': bytes[2]});
					bytes = bytes.slice(3);
				}
				ret[name] = a;
				break;
			case 'uint16l': // uint16 list, any number
				if (bytes.length % 2 !== 0) {
					return "list of 16 bit numbers is not a multiple of 2 bytes";
				}
				while (bytes.length !== 0) {
					a.push(to16(bytes));
					bytes = bytes.slice(2);
				}
				ret[name] = a;
				break;
			case 'bytes':
				ret[name] = bytes.slice();
				bytes = [];
				break;
			case 'keyword': // zero terminated string 1-79 bytes in ISO 8859-1
				k = zterm();
				if (typeof k == 'undefined') {
					return "string not null terminated";
				}
				if (k.length === 0 || k.length > 79) {
					return "keyword empty or too long";
				}
				if (k[0] === 32 || k[k.length - 1] === 32) {
					return "leading or trailing space in keyword";
				}
				if (k.indexOf(160) !== -1) {
					return "non break space not allowed in keyword";
				}
				if (k.indexOf(10) !== -1) {
					return "line feed not allowed in keyword";
				}
				s = latinToString(k);
				if (typeof s == 'undefined') {
					return "invalid ISO 8859-1 in keyword";
				}
				// should also check for multiple spaces if pedantic
				ret[name] = s;
				break;
			case 'ascii-0': // zero terminated ascii string
				k = zterm();
				if (typeof k == 'undefined') {
					return "string not null terminated";
				}
				s = asciiToString(k);
				if (typeof s == 'undefined') {
					return "invalid ASCII in string";
				}
				ret[name] = s;
				break;
			case 'utf8-0': // zero terminated UTF8 string
				k = zterm();
				if (typeof k == 'undefined') {
					return "string not null terminated";
				}
				s = utf8ToString(k);
				if (typeof s == 'undefined') {
					return "invalid UTF8 in string";
				}
				ret[name] = s;
				break;
			case 'z-optional': // iTXt optional compression field
				if (bytes.length < 2) {
					return "not enough data";
				}
				if (bytes[0] > 1 || bytes[1] !== 0) {
					return "invalid compression setting";
				}
				ret[name] = (bytes[0] === 1);
				bytes = bytes.slice(2);
				break;
			case 'oz-utf8': // optionally compressed UTF8 terminated by end of data
				if (ret.compression === true) {
					//z = inflate(bytes); // !!!!!!!!!!!!
					z = [];
				} else {
					z = bytes.slice();
				}
				s = utf8ToString(z);
				if (typeof s == 'undefined') {
					return "invalid UTF8 in string";
				}
				ret[name] = s;
				bytes = [];
				break;
			case 'iso8859-1': // string terminated by end of data
				s = latinToString(bytes);
				if (typeof s == 'undefined') {
					return "invalid ISO 8859-1 in string";
				}
				ret[name] = s;
				bytes = [];
				break;
			case 'z-iso8859-1': // compressed string terminated by end of data
				if (bytes[0] !== 0) {
					return "unknown compression method";
				}
				bytes.shift();
				//z = inflate(bytes);
				//s = latinToString(z);
				s = "unable to uncompress yet!!!!!!!!";
				if (typeof s == 'undefined') {
					return "invalid ISO 8859-1 in string";
				}
				ret[name] = s;
				bytes = [];
				break;
			case 'zdata': // compressed arbitrary data
				if (bytes[0] !== 0) {
					return "unknown compression method";
				}
				bytes.shift();
				// unable to uncompress yet!!!!!!!!
				ret[name] = bytes.slice(); // return compressed instead...
				bytes = [];
				break;
			default:
				return "cannot understand field to parse";
		}
	}
	if (bytes.length !== 0) {
		return "too much data: " + bytes.length + " " + fields;
	}
	
	return ret;
};

cfsm.IHDR = {
	parse: ['width', 'uint32', 'height', 'uint32', 'depth', 'uint8', 'type', 'uint8', 'compression', 'uint8', 'filter', 'uint8', 'interlace', 'uint8'],
	validate: function(d) {
		if (d.width === 0 || d.height === 0) {
			return "width and height of PNG must not be zero";
		}

		if ([1, 2, 4, 8, 16].indexOf(d.depth) === -1) {
			return "invalid bit depth";
		}

		switch(d.type) {
			case 0: // greyscale
				break;
			case 2: // truecolour
			case 4: // greyscale with alpha
			case 6: // truecolour with alpha
				if (d.depth < 8) {
					return "invalid bit depth";
				}
				break;
			case 3: // indexed colour
				if (d.depth > 8) {
					return "invalid bit depth";
				}
				break;
			default:
				return "invalid colour type";
		}

		if (d.compression !== 0) {
			return "invalid compression type";
		}
		
		if (d.filter !== 0) {
			return "invalid filter type";
		}
		
		if (d.filter !== 0 && d.filter !== 1) {
			return "invalid interlace type";
		}
		return;
	},
	state: function(d) {
		this.header = d; // other chunks need to see this header
		
		this.emit('IHDR', d); // move to generic code?
		
		console.log("header: colour type " + d.type);
		
	}
};

cfsm.PLTE = {
	parse: ["palette", "rgb"],
	state: function(d) {
		this.emit('PLTE', d);
	}
};

cfsm.IDAT = {
	parse: function(data) {
		return {'data': data}; // actually special case?
	},
	state: function(d) {
		this.emit('IDAT', d); // this is possiby the only one that needs to do something else?
		console.log("need to process IDAT data!");
	}
};

cfsm.IEND = {
	parse: [],
	state: function(d) {
		this.emit('IEND', d);
		this.emit('end');
	}
};

cfsm.gAMA = {
	parse: ['gamma', 'float100k'],
	state: function (d) {
		this.emit('gAMA', d);		
	}
};

cfsm.sBIT = {
	parse: function(data) {
		var p;
		switch (this.header.type) {
			case 0:
				p = ["grey", "uint8"];
				break;
			case 2:
			case 3:
				p = ["red", "uint8", "green", "uint8", "blue", "uint8"];
				break;
			case 4:
				p = ["grey", "uint8", "alpha", "uint8"];
				break;
			case 6:
				p = ["red", "uint8", "green", "uint8", "blue", "uint8", "alpha", "uint8"];
				break;
		}
		return this.parseField(data, p);
	},
	validate: function(d) {
		var depth = (this.header.type === 3) ? 8 : this.header.depth;
		var keys = Object.keys(d);
		for (var i = 0; i < keys.length; i++) {
			if (d[keys[i]] === 0 || d[keys[i]] > depth) {
				return "invalid significant bits";
			}
		}
		return;
	},
	state: function(d) {
		this.emit('sBIT', d);
	}
};
cfsm.bKGD = {
	parse: function(data) {
	var p;
		switch (this.header.type) {
			case 0:
			case 4:
				p = ["grey", "uint16"];
				break;
			case 2:
			case 6:
				p = ["red", "uint16", "green", "uint16", "blue", "uint16"];
				break;
			case 3:
				p = ["palette", "uint8"];
				break;
		}
		return this.parseField(data, p);
	},
	validate: function(d) {
		var max = 1 << ((this.header.type === 3) ? 8 : this.header.depth);
		var keys = Object.keys(d);
		for (var i = 0; i < keys.length; i++) {
			if (d[keys[i]] >= max) {
				return "invalid background colour " + d[keys[i]] + " max " + max;
			}
		}
		return;
	},
	state: function(d) {
		this.emit('bKGD', d);
	}
};

cfsm.tRNS = {
	parse: function(data) {
		var p;
		switch (this.header.type) {
			case 0:
				p = ["grey", "uint16"];
				break;
			case 2:
				p = ["red", "uint16", "green", "uint16", "blue", "uint16"];
				break;
			case 3:
				p = ["alpha", "bytes"];
				break;
		}
		return this.parseField(data, p);
	},
	state: function(d) {
		this.emit('tRNS', d);
	}
};

cfsm.cHRM = {
	parse: ['whiteX', 'float100k', 'whiteY', 'float100k', 'redX', 'float100k', 'redY', 'float100k', 'greenX', 'float100k', 'greenY', 'float100k', 'blueX', 'float100k', 'blueY', 'float100k'],
	state: function(d) {
		this.emit('cHRM', d);
	}
};
cfsm.pHYs = {
	parse: ['pixelsX', 'uint32', 'pixelsY', 'uint32', 'unit', 'uint8'],
	state: function(d) {
		this.emit('pHYs', d);
	}
};
cfsm.hIST = {
	parse: ['frequencies', 'uint16l'],
	state: function(d) {
		this.emit('hIST', d);
	}
};
cfsm.tIME = {
	parse: ['year', 'uint16', 'month', 'uint8', 'day', 'uint8', 'hour', 'uint8', 'minute', 'uint8', 'second', 'uint8'],
	validate: function(d) {
		if (d.month === 0 || d.month > 12 || d.day === 0 || d.day > 31 || d.hour > 23 || d.minute > 59 || d.second > 60) {
			return "invalid date";
		}
		// check actual number of days in month
		if (d.day > 32 - new Date(d.year, d.month, 32).getDate()) {
			return "invalid days in month";
		}
	},
	state: function(d) {
		this.emit('tIME', d);
	}
};
cfsm.tEXt = {
	parse: ['keyword', 'keyword', 'text', 'iso8859-1'],
	state: function(d) {
		this.emit('tEXt', d);
		
		console.log("text: " + d.keyword + ": " + d.text);
	}
};
cfsm.zTXt = {
	parse: ['keyword', 'keyword', 'text', 'z-iso8859-1'],
	state: function(d) {
		this.emit('zTXt', d);
		
		console.log("ztext: " + d.keyword + ": " + d.text);
	}
};

cfsm.iTXt = {
	parse: ['keyword', 'keyword', 'compression', 'z-optional', 'language', 'ascii00', 'translated', 'utf8-0', 'text', 'oz-utf8'],
	state: function(d) {
		this.emit('iTXt', d);

		console.log("ztext: " + d.keyword + ": " + d.text);
	}
};

cfsm.iCCP = {
	parse: ['name', 'keyword', 'profile', 'zdata'],
	state: function(d) {
		this.emit('iCCP', d);
	}
};

cfsm.sRGB = {
	parse: ['intent', 'uint8'],
	validate: function(d) {
		if (d.intent > 3) {
			return "unknown sRGB intent";
		}
	},
	state: function(d) {
		this.emit('sRGB', d);
	}
};

cfsm.finish = function() {
	//cleanup listeners?
};
cfsm.error = function(msg) {
	console.log(msg);
	this.finish(); // not sure need this here?
	this.emit('error');
	return;
};

// pass the functions instead?
cfsm.listen = function(emitter, chunks) {
	var cfsm = this;
	var i;
	var fs;
	
	function unlisten() {
		emitter.removeListener('bad', bad);
		emitter.removeListener('end', end);
		chunks.map(function(cn, ci) {emitter.removeListener(cn, fs[ci]);});
	}
	
	function end() {
		unlisten();
		cfsm.emit('end');
	}
	
	function bad(msg) {
		unlisten();
		cfsm.emit('bad', msg);
	}
	
	if (typeof chunks == 'undefined') {
		chunks = [];
		for (i in this) {
			if (typeof this[i] == 'object') {
				chunks.push(i);
			}
		}
	}
	
	function process(cn, data) {
		var ci = cfsm[cn];

		console.log("receive event " + cn);

		var d = (typeof ci.parse == 'function') ? ci.parse.call(cfsm, data) : cfsm.parseField(data, ci.parse);
		
		if (typeof d == 'string') {
			return bad(d);
		}

		if (typeof ci.validate == 'function') {
			var v = ci.validate.call(cfsm, d);

			if (typeof v == 'string') {
				return bad(v);
			}
		}
		if (typeof ci.state == 'function') {
			var ret = ci.state.call(cfsm, d);
			if (typeof ret === 'string') {
				return bad(ret);
			}
		}
	}
	
	emitter.on('end', end);
	emitter.on('bad', bad);
	
	fs = chunks.map(function(cn) {
		function f(data) {
			process(cn, data);
		}
		
		emitter.on(cn, f);
		return f;
	});
	
	return this;
};

cfsm.stream = function(stream) {
	var p = Object.create(png);
	this.listen(p);
	p.stream(stream);
	
	return this;
};

(function(exports) {
	exports.cfsm = cfsm;
	exports.png = png;
})(

  typeof exports === 'object' ? exports : this
);


