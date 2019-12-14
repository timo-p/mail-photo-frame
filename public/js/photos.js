var show = function (next) {
  stopNextImageCounter();
  var divs = $('div.image');
  var active = $('div.image:visible');
  var nextImage = divs.first();
  if (active.length === 1) {
    if (next) {
      nextImage = active.next();
      nextImage = nextImage.length === 0 ? divs.first() : nextImage;
    } else {
      nextImage = active.prev();
      nextImage = nextImage.length === 0 ? divs.last() : nextImage;
    }
  }
  if (active.length === 1) {
    active.fadeOut(400, function () {
      nextImage.fadeIn(400, function () {
        startNextImageCounter();
      });
    });
  } else {
    nextImage.fadeIn(400, function () {
      startNextImageCounter();
    });
  }
}

var nextCounter;

var stopNextImageCounter = function () {
  clearInterval(nextCounter);
}

var startNextImageCounter = function () {
  clearInterval(nextCounter);
  nextCounter = setInterval(function () {
    show(true);
  }, 30000);
}

$(document).ready(function () {
  show(true);

  startNextImageCounter();

  setTimeout(function () {
    window.location.reload();
  }, 3600000);

  $('#prev').click(function () {
    show(false);
  });

  $('#next').click(function () {
    show(true);
  });
});